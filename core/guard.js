// The guard: crew sessions run with broad permissions and nobody watching, so some actions are
// refused whatever the permission mode: protected or forced pushes, commits on a protected branch,
// secret files, and the mission's own state folder. Others cannot be undone (a recursive delete out of
// the working folder, `git reset --hard`…): they are refused too, but marked `irreversible`, so the
// PreToolUse hook can ask the user and let them through once. Used by the hooks in core/hooks/.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runFileSync } = require('./run-file');
const { home, missionDir } = require('./paths');
const { readJson } = require('./store');
const { DEFAULTS } = require('./config');
const layout = require('./layout');

// File names that differ only by case are the same file on macOS and Windows.
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

// The branch of a folder reached through `cd $DIR` or `cd -`: only known when the shell runs.
const COMPUTED = '$computed';
// The current branch when git could not read it: a bare push or a commit there is refused.
const UNKNOWN = '$unknown';

// Words that start a shell construct: the command itself comes after them.
const SHELL_KEYWORDS = ['{', '}', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time'];

// Git options placed before the subcommand that take the next word as their value.
const GIT_OPTIONS_WITH_VALUE = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source'];

// Push options that take the next word as their value (besides -o).
const PUSH_OPTIONS_WITH_VALUE = ['--push-option', '--repo', '--receive-pack', '--exec'];

// Tools that read or write one file or folder, and the input field that names it.
const FILE_TOOLS = new Map([
  ['Read', 'file_path'],
  ['Write', 'file_path'],
  ['Edit', 'file_path'],
  ['NotebookEdit', 'notebook_path'],
  ['Grep', 'path'],
  ['Glob', 'path'],
]);

// Tools that change a file: confined to the session's working folder.
const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit'];

// Files and folders of the home folder that hold keys and tokens: no session reads them.
const SENSITIVE_IN_HOME = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.netrc',
  path.join('.config', 'gh'),
  path.join('.config', 'anthropic'),
  path.join('.config', 'gcloud'),
  path.join('Library', 'Keychains'),
  '.claude.json',
  path.join('.claude', '.credentials.json'),
  '.npmrc',
  '.git-credentials',
  path.join('.docker', 'config.json'),
  '.kube',
];

// Said after a refusal of the confinement, so the session does not look for a detour (`node -e`…).
const WRITE_ADVICE = 'Do not look for a way around it: finish what you can in your folder and say in your summary what you could not write.';
const READ_ADVICE = 'Do not look for a way around it: say in your summary what you could not read.';

// Config patterns: `*` matches any characters; everything else is literal.
function globMatch(pattern, text, ignoreCase = false) {
  const parts = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('.*')}$`, ignoreCase ? 'is' : 's').test(text);
}

// Shell globs in a command word: `*`, `?` and `[…]`.
function shellGlobRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const end = glob[i] === '[' ? glob.indexOf(']', i + 2) : -1;
    if (glob[i] === '*') source += '.*';
    else if (glob[i] === '?') source += '.';
    else if (end !== -1) {
      source += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
      i = end;
    } else source += glob[i].replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, CASE_INSENSITIVE ? 'i' : '');
}

// --- Reading a Bash command -------------------------------------------------------------------

// `$(…)`, `<(…)`, `>(…)` and backticks run commands of their own. Each is cut out, innermost
// first, and replaced by `$_`: a word with `$` is computed by the shell. Returns the commands cut
// out, then the main one.
function cutSubstitutions(command) {
  const inner = [];
  let text = command;
  const substitution = /[$<>]\(([^()]*)\)|`([^`]*)`/;
  let match;
  while ((match = substitution.exec(text))) {
    inner.push(match[1] ?? match[2]);
    text = text.slice(0, match.index) + '$_' + text.slice(match.index + match[0].length);
  }
  return [...inner, text];
}

// Index of the newline that ends the bodies of the heredocs started on the line ending at `i`.
// Each body goes up to the line holding its delimiter (tabs before it allowed). Without a
// delimiter or without that line it is not a heredoc we can trust: `i` is returned, so nothing
// is skipped.
function skipHeredocBodies(text, i, delimiters) {
  let end = i;
  for (const delimiter of delimiters) {
    let closed = false;
    while (!closed && end < text.length) {
      const start = end + 1;
      end = text.indexOf('\n', start) === -1 ? text.length : text.indexOf('\n', start);
      closed = text.slice(start, end).replace(/^\t+/, '') === delimiter;
    }
    if (!delimiter || !closed) return i;
  }
  return end;
}

// Splits a command into pieces: {words, redirects, end}. Quotes are removed and a backslash
// escapes the next character, as in the shell; `$'…'` is a quote where `\'` stays inside. A piece
// ends at ; & && | || ( ) or a newline outside quotes; `end` keeps which one. A redirection keeps its
// operator (`>/dev/null`, `<.env`) and goes to `redirects`; the descriptor number of `2>&1` is
// dropped. Comments (`#` starting a word) and heredoc bodies are data: they are skipped here, and
// checkBash judges every line on its own anyway. Inside parentheses or `[[ … ]]`, `<<` may be a
// shift or a comparison (`$((1<<2))`), so no body is skipped there. Splitting more than the shell
// does is harmless: it only makes more pieces to judge.
function splitPieces(text) {
  const pieces = [];
  let words = [];
  let redirects = [];
  let word = null;
  let quote = null;
  let redirecting = false;
  let delimiterAt = null; // where the delimiter starts in the word of a `<<` or `<<-` redirection
  let heredocs = []; // delimiters of the heredocs started on the current line
  let parentheses = 0; // how many are open
  let inTest = false; // between `[[` and `]]`
  const endWord = () => {
    if (word !== null && delimiterAt !== null) heredocs.push(word.slice(delimiterAt));
    if (word !== null) (redirecting ? redirects : words).push(word);
    word = null;
    redirecting = false;
    delimiterAt = null;
  };
  const endPiece = (end) => {
    endWord();
    pieces.push({ words, redirects, end });
    words = [];
    redirects = [];
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
    } else if (quote === "$'") {
      if (char === "'") quote = null;
      else if (char === '\\' && next !== undefined) word += text[++i];
      else word += char;
    } else if (char === '\\' && next !== undefined && (!quote || '$`"\\\n'.includes(next))) {
      i++;
      if (next !== '\n') word = (word ?? '') + next;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else word += char;
    } else if (char === '$' && next === "'") {
      quote = "$'";
      word = word ?? '';
      i++;
    } else if (char === '"' || char === "'") {
      quote = char;
      word = word ?? '';
    } else if (char === '#' && word === null) {
      while (text[i + 1] !== undefined && text[i + 1] !== '\n') i++;
    } else if (char === '<' || char === '>' || (char === '&' && next === '>')) {
      if (word !== null && /^\d+$/.test(word)) word = null;
      endWord();
      word = char;
      while (text[i + 1] !== undefined && '<>&'.includes(text[i + 1])) word += text[++i];
      if (word === '<<' && text[i + 1] === '-') word += text[++i];
      if (/^<<-?$/.test(word) && parentheses === 0 && !inTest) delimiterAt = word.length;
      while (text[i + 1] === ' ' || text[i + 1] === '\t') i++;
      redirecting = true;
    } else if (char === '&' || char === '|') {
      const double = next === char;
      if (double || (char === '|' && next === '&')) i++;
      endPiece(double ? char + char : char);
    } else if (';()\r\n'.includes(char)) {
      endPiece(char === '\r' ? '\n' : char);
      if (char === '(') parentheses++;
      if (char === ')' && parentheses > 0) parentheses--;
      if (char === '\n' && heredocs.length) i = skipHeredocBodies(text, i, heredocs) - 1;
      if (char === '\n') heredocs = [];
    } else if (/\s/.test(char)) {
      endWord();
    } else {
      if (word === null && text.startsWith('[[', i)) inTest = true;
      if (word === null && /^\]\]($|[\s;&|)])/.test(text.slice(i, i + 3))) inTest = false;
      word = (word ?? '') + char;
    }
  }
  endPiece('');
  return pieces;
}

// Every command of a Bash call, each as a list of pieces: the substitutions, then the main one.
function bashCommands(command) {
  return cutSubstitutions(String(command)).map(splitPieces);
}

// Index of the command word, after shell keywords such as `if`, `then`, `{` or `!`.
function commandStart(words) {
  let i = 0;
  while (i < words.length && SHELL_KEYWORDS.includes(words[i])) i++;
  return i;
}

// --- Folders and branches ---------------------------------------------------------------------

// `~`, `$HOME` and `$RELAYLEAD_HOME` (and `%USERPROFILE%` on Windows) replaced by their value.
function expandHome(file) {
  // Functions as replacements, so a `$` in the home path is not read as a replacement pattern.
  let result = file
    .replace(/^~(?=[\\/]|$)/, () => os.homedir())
    .replace(/\$(\{HOME\}|HOME\b)/g, () => os.homedir())
    .replace(/\$(\{RELAYLEAD_HOME\}|RELAYLEAD_HOME\b)/g, () => home());
  if (process.platform === 'win32') result = result.replace(/%USERPROFILE%/gi, () => os.homedir());
  return result;
}

// The real path of `file`: links followed, and `/tmp` read as `/private/tmp` on macOS. A path not
// made yet gets the real path of its nearest existing parent, with the rest added; a link that
// points to nothing yet is followed all the same, since a write would go where it points.
function realPath(file) {
  let current = path.resolve(file);
  const rest = [];
  for (let links = 0; links < 40; ) {
    try {
      return path.join(fs.realpathSync(current), ...rest);
    } catch {
      // missing: a link that points to nothing, or a path not made yet
    }
    let target = null;
    try {
      if (fs.lstatSync(current).isSymbolicLink()) target = fs.readlinkSync(current);
    } catch {
      // nothing at all there
    }
    if (target !== null) {
      current = path.resolve(path.dirname(current), target);
      links++;
      continue;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    rest.unshift(path.basename(current));
    current = parent;
  }
  return path.resolve(file);
}

// True when `file` is `folder` or inside it. Both paths are already resolved.
function isInside(file, folder) {
  const normalize = (p) => (CASE_INSENSITIVE ? p.toLowerCase() : p);
  const full = normalize(file);
  const base = normalize(folder);
  return full === base || full.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

// Same, compared as written and as real paths: `/tmp/x` and `/private/tmp/x` are one file, and so
// are a link and what it points to.
function reaches(file, folder) {
  return isInside(path.resolve(file), path.resolve(folder)) || isInside(realPath(file), realPath(folder));
}

// The temporary folder Claude Code tells its sessions to use: /tmp/claude-<uid>. None on Windows.
function claudeTempDir() {
  return process.getuid ? path.join('/tmp', `claude-${process.getuid()}`) : null;
}

// `target` seen from `dir`; null when only the shell knows it (a variable, `cd -`, an unknown dir).
function moveTo(dir, target) {
  const expanded = expandHome(target);
  if (dir === null || target === '-' || /[$`]/.test(expanded)) return null;
  return path.resolve(dir, expanded);
}

// The branch checked out in `dir`: null on a detached HEAD, COMPUTED when the folder itself is
// unknown, UNKNOWN when git cannot say (not a repository, git too slow or failing).
// `rev-parse` fails on a branch with no commit yet: `symbolic-ref` still names it.
function currentBranch(dir) {
  if (dir === null) return COMPUTED;
  const options = {
    cwd: dir,
    env: { ...process.env, LC_ALL: 'C' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10000,
    windowsHide: true,
  };
  // Like every git command relaylead runs itself: no gc or maintenance left in the background,
  // messages in English, and no wait for a process git leaves behind with its output open.
  const git = (...args) => runFileSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], options);
  try {
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
    return branch === 'HEAD' ? null : branch;
  } catch {
    // try the other way below
  }
  try {
    return git('symbolic-ref', '--short', 'HEAD').trim();
  } catch {
    return UNKNOWN;
  }
}

// Reason to refuse `action` ('push to', 'commit on') on `branch`, or null.
function branchRefusal(action, branch, guard) {
  if (branch === null) return null;
  if (branch === UNKNOWN) return `${action} an unreadable branch: current branch unknown`;
  // `$BRANCH`, `$(…)`, an unknown folder, a pattern such as `refs/heads/*`, or `{main,x}`.
  if (/[$*?[{]/.test(branch)) return `${action} a branch that cannot be judged`;
  if (guard.protectedBranches.some((pattern) => globMatch(pattern, branch))) {
    return `${action} protected branch ${branch}`;
  }
  return null;
}

// --- Git --------------------------------------------------------------------------------------

// `git`, `/usr/bin/git`, `GIT` or `git.exe`.
function isGitWord(word) {
  return path.win32.basename(word).toLowerCase().replace(/\.exe$/, '') === 'git';
}

// The first git call of a piece, wherever it is (`timeout 60 git …`, `if true; then git …`):
// its subcommand, the index of its first argument, and the folder git works in. Null without git.
function parseGit(words, dir) {
  let i = words.findIndex(isGitWord);
  if (i === -1) return null;
  for (i++; i < words.length && words[i].startsWith('-'); i++) {
    let option = words[i];
    let value = null;
    if (option.startsWith('--') && option.includes('=')) {
      value = option.slice(option.indexOf('=') + 1);
      option = option.slice(0, option.indexOf('='));
    } else if (GIT_OPTIONS_WITH_VALUE.includes(option)) {
      value = words[++i] ?? '';
    }
    if (['-C', '--git-dir', '--work-tree'].includes(option)) dir = moveTo(dir, value);
  }
  if (i >= words.length) return null;
  return { subcommand: words[i].toLowerCase(), start: i + 1, dir };
}

// True when `arg` is `full` or an abbreviation of it (`--forc` for `--force`, `--m` for `--mirror`).
// An abbreviation git finds ambiguous fails anyway, so taking it for `full` is harmless.
function isLongOption(arg, full) {
  const name = arg.split('=')[0];
  return name.length >= 3 && full.startsWith(name);
}

// Branch a refspec writes to: `main`, `HEAD:main`, `src:refs/heads/main`, `:main` (delete) all give main.
function destination(refspec, dir) {
  const [source, target] = refspec.replace(/^\+/, '').split(':');
  const branch = (target || source).replace(/^(refs\/)?heads\//, '');
  return branch === 'HEAD' || branch === '@' || branch === '' ? currentBranch(dir) : branch;
}

function checkPush(args, dir, guard) {
  const positional = [];
  let repoOption = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--all', '--branches', '--mirror'].some((option) => isLongOption(arg, option))) return 'push of every branch';
    // --force, --force-with-lease[=…], and -f alone or grouped with other short options (-uf).
    if (isLongOption(arg, '--force') || isLongOption(arg, '--force-with-lease') || /^-[^-]*f/.test(arg)) {
      return 'force push';
    }
    const takesValue = arg === '-o' || PUSH_OPTIONS_WITH_VALUE.some((o) => !arg.includes('=') && isLongOption(arg, o));
    if (isLongOption(arg, '--repo')) repoOption = true;
    if (takesValue) i++;
    else if (!arg.startsWith('-')) positional.push(arg);
  }
  // The first word is the remote, unless --repo names it: then every word may be a refspec.
  const refspecs = repoOption ? positional : positional.slice(1);
  if (refspecs.some((refspec) => refspec.startsWith('+'))) return 'force push';
  // Without a refspec, git pushes the current branch.
  const branches = refspecs.length ? refspecs.map((refspec) => destination(refspec, dir)) : [currentBranch(dir)];
  for (const branch of branches) {
    const reason = branchRefusal('push to', branch, guard);
    if (reason) return reason;
  }
  return null;
}

// Indexes of the commit message words of `git commit` (-m, --message, -am): data, not file names.
function commitMessageIndexes(words, start) {
  const indexes = new Set();
  for (let i = start; i < words.length; i++) {
    const short = /^-[a-zA-Z]*?m(.*)$/.exec(words[i]);
    const long = isLongOption(words[i], '--message');
    if ((short && short[1]) || (long && words[i].includes('='))) indexes.add(i);
    else if (short || long) indexes.add(++i);
  }
  return indexes;
}

// --- Files ------------------------------------------------------------------------------------

// True when `name` is a secret file name, or a glob that may match one. `dotFiles` says whether a
// leading wildcard matches a name that starts with a dot: not in the shell, but in ripgrep.
function isSecretName(name, guard, dotFiles = false) {
  if (guard.secretExceptions.some((pattern) => globMatch(pattern, name, CASE_INSENSITIVE))) return false;
  if (!/[*?[]/.test(name)) return guard.secrets.some((pattern) => globMatch(pattern, name, CASE_INSENSITIVE));
  // A glob may match a secret when one matches an example of the other.
  const word = shellGlobRegExp(name);
  const wordExample = name.replace(/\[[^\]]*\]|[*?]/g, 'x');
  return guard.secrets.some((pattern) => {
    const examples = [pattern.replace(/\*/g, ''), pattern.replace(/\*/g, 'x')];
    const hidesDotFiles = !dotFiles && /^[*?[]/.test(name);
    const meets = examples.some((example) => word.test(example) && !(hidesDotFiles && example.startsWith('.')));
    return meets || globMatch(pattern, wordExample, CASE_INSENSITIVE);
  });
}

// True when a glob path may name something inside the state folder: each of its first segments
// matches the state folder's (in the shell, `*` does not cross a `/`). A `**` segment crosses
// folders: once the segments before it match the state folder's first ones, the path may reach it.
function globMayReach(file, dir, stateDir) {
  const parts = path.resolve(dir || '', file).split(path.sep);
  const folder = path.resolve(stateDir).split(path.sep);
  for (let i = 0; i < folder.length; i++) {
    if (parts[i] === '**') return true;
    if (parts[i] === undefined || !shellGlobRegExp(parts[i]).test(folder[i])) return false;
  }
  return true;
}

// True when `word` names something in the state folder. `~user` may be this user's home, so it
// is read as `~`. Only the shell knows what a variable, a brace range or `~+` gives: such a word
// counts as inside when it names the state folders. A glob is compared with the real folder.
function inStateFolder(word, dir, stateDir) {
  if (!stateDir || !word) return false;
  const file = expandHome(word.replace(/^~[^\\/+-]*/, '~'));
  if (/[$`{]/.test(file) || file.startsWith('~')) return /\.relaylead|missions/i.test(file);
  if (dir === null && !path.isAbsolute(file)) return false;
  if (/[*?[]/.test(file)) return globMayReach(file, dir, stateDir);
  return reaches(path.resolve(dir || '', file), stateDir);
}

// Brace expansion, as the shell does it: `a{b,c}` gives `ab` and `ac`. A range such as `{1..3}`
// stays as it is. A word that would give more than 64 names is not expanded: null, it cannot be judged.
function expandBraces(word) {
  const group = /\{([^{}]*,[^{}]*)\}/;
  let words = [word];
  while (words.length <= 64 && words.some((w) => group.test(w))) {
    words = words.flatMap((w) => {
      const match = group.exec(w);
      if (!match) return [w];
      const [before, after] = [w.slice(0, match.index), w.slice(match.index + match[0].length)];
      return match[1].split(',').map((choice) => before + choice + after);
    });
  }
  return words.some((w) => group.test(w)) ? null : words;
}

// Reason to refuse a file named in a Bash word, or null. `--env-file=.env` names .env too.
// `dotFiles` as in isSecretName.
function checkFileWord(word, dir, guard, stateDir, dotFiles = false) {
  const names = expandBraces(word.replace(/^[<>&]+/, ''));
  if (names === null) return 'a brace expansion that cannot be judged';
  for (const part of names.flatMap((name) => name.split('='))) {
    if (inStateFolder(part, dir, stateDir)) return 'access to the mission state folder';
    const name = path.posix.basename(part);
    if (name && isSecretName(name, guard, dotFiles)) return `access to secret file ${name}`;
  }
  return null;
}

// --- Judging ----------------------------------------------------------------------------------

// Reason to refuse one piece of a Bash command run in `dir`, or null.
function checkPiece({ words, redirects }, dir, guard, stateDir) {
  const git = parseGit(words, dir);
  // Words that are data, not file names: what echo and printf print, and commit messages.
  const command = words[commandStart(words)];
  const printed = command === 'echo' || command === 'printf';
  const message = git && git.subcommand === 'commit' ? commitMessageIndexes(words, git.start) : new Set();
  const fileWords = [...words.filter((word, i) => !printed && !message.has(i)), ...redirects];
  for (const word of fileWords) {
    const reason = checkFileWord(word, dir, guard, stateDir);
    if (reason) return reason;
  }
  if (git && git.subcommand === 'push') return checkPush(words.slice(git.start), git.dir, guard);
  if (git && git.subcommand === 'commit') return branchRefusal('commit on', currentBranch(git.dir), guard);
  return null;
}

// True when `target`, seen from `dir`, is strictly inside the working folder `workDir`. A target
// only the shell knows (a variable, a folder after `cd $X`) is not.
function insideFolder(target, dir, workDir) {
  const resolved = moveTo(dir, target);
  if (resolved === null || !workDir) return false;
  const normalize = (p) => (CASE_INSENSITIVE ? p.toLowerCase() : p);
  return normalize(resolved).startsWith(normalize(path.resolve(workDir)) + path.sep);
}

// Short options grouped in one word (`-rf`) hold `letter`.
function hasShortOption(args, letter) {
  return args.some((arg) => /^-[^-]/.test(arg) && arg.slice(1).includes(letter));
}

// Reason to ask before one piece of a Bash command run in `dir`, or null: an action that cannot be
// undone. `workDir` is the session's working folder: a recursive delete inside it is ordinary work.
function irreversibleReason({ words }, dir, workDir) {
  const command = words[commandStart(words)];
  if (command === 'echo' || command === 'printf') return null;
  const rm = words.findIndex((word) => path.win32.basename(word) === 'rm');
  if (rm !== -1) {
    const args = words.slice(rm + 1);
    const end = args.indexOf('--');
    const options = end === -1 ? args : args.slice(0, end);
    const recursive = hasShortOption(options, 'r') || hasShortOption(options, 'R') || options.some((arg) => isLongOption(arg, '--recursive'));
    const targets = args.filter((arg, i) => (end !== -1 && i > end) || !arg.startsWith('-'));
    if (recursive && targets.some((target) => !insideFolder(target, dir, workDir))) {
      return 'irreversible: recursive delete outside the working folder';
    }
  }
  const git = parseGit(words, dir);
  if (!git) return null;
  const args = words.slice(git.start);
  const force = hasShortOption(args, 'f') || args.some((arg) => isLongOption(arg, '--force'));
  const deletion = hasShortOption(args, 'd') || args.some((arg) => isLongOption(arg, '--delete'));
  if (git.subcommand === 'reset' && args.includes('--hard')) return 'irreversible: git reset --hard';
  if (git.subcommand === 'clean' && force) return 'irreversible: git clean -f';
  if (git.subcommand === 'branch' && (hasShortOption(args, 'D') || (deletion && force))) return 'irreversible: git branch -D';
  if (git.subcommand === 'push' && (deletion || args.some((arg) => /^:./.test(arg)))) return 'irreversible: git push --delete';
  if (git.subcommand === 'checkout' && args.includes('.')) return 'irreversible: git checkout -- .';
  if (git.subcommand === 'restore' && args.includes('.')) return 'irreversible: git restore .';
  const stashAction = args.find((arg) => !arg.startsWith('-'));
  if (git.subcommand === 'stash' && ['drop', 'clear'].includes(stashAction)) return `irreversible: git stash ${stashAction}`;
  return null;
}

// Folders the next pieces may run in after a `cd` or `pushd` piece run in `dirs`; null when the
// piece does not change folder.
function cdTargets(words, dirs) {
  const start = commandStart(words);
  if (words[start] === 'popd') return [null];
  if (words[start] !== 'cd' && words[start] !== 'pushd') return null;
  const target = words.slice(start + 1).find((word) => word === '-' || !word.startsWith('-'));
  return dirs.map((dir) => (target === undefined ? os.homedir() : moveTo(dir, target)));
}

// Each piece is judged in every folder it may run in. `cd x && …` moves the rest of the &&
// chain to x; once the chain ends, the cd may have failed, so the former folders are possible
// again. After `cd x;` or `cd x ||` both folders are possible. A cd in a pipe, in the background
// or inside `( … )` does not move the pieces after it. Returns the first reason to refuse; the
// reasons to ask first (irreversibleReason) go to `irreversible`, so a refusal is never hidden by them.
function checkCommand(command, cwd, guard, stateDir, irreversible) {
  for (const pieces of bashCommands(command)) {
    let dirs = [cwd];
    let beforeChain = null; // the folders before a `cd … &&` chain
    let previousEnd = '';
    const groups = [];
    for (const piece of pieces) {
      for (const dir of dirs) {
        const reason = checkPiece(piece, dir, guard, stateDir);
        if (reason) return reason;
        const ask = irreversibleReason(piece, dir, cwd);
        if (ask) irreversible.push(ask);
      }
      const moved = cdTargets(piece.words, dirs);
      // Before `||`, a failed cd runs the next piece in the former folder, a successful one may
      // reach later pieces (`cd x || exit 1; git push`): both folders stay possible, as after `;`.
      const lasts = moved && previousEnd !== '|' && !['|', '&', ')'].includes(piece.end);
      if (lasts && piece.end === '&&') {
        beforeChain = beforeChain || dirs;
        dirs = moved;
      } else if (lasts) {
        dirs = [...new Set([...dirs, ...moved])];
      }
      if (piece.end !== '&&' && beforeChain) {
        dirs = [...new Set([...dirs, ...beforeChain])];
        beforeChain = null;
      }
      if (piece.end === '(') groups.push(dirs);
      if (piece.end === ')' && groups.length) dirs = groups.pop();
      previousEnd = piece.end;
    }
  }
  return null;
}

// The whole command is judged, then each of its lines on its own. The line pass has no secret
// list: commit messages and heredoc bodies may mention a secret, but every line is judged for
// pushes, commits and the state folder, so a quote the reader gets wrong never hides one.
// Returns {reason, irreversible} or null: an action that cannot be undone only when nothing else
// refuses the command.
function checkBash(command, cwd, guard, stateDir) {
  const lines = command.includes('\n') ? command.split('\n') : [];
  const noSecrets = { ...guard, secrets: [] };
  const irreversible = [];
  for (const [text, rules] of [[command, guard], ...lines.map((line) => [line, noSecrets])]) {
    const reason = checkCommand(text, cwd, rules, stateDir, irreversible);
    if (reason) return { reason, irreversible: false };
  }
  return irreversible.length > 0 ? { reason: irreversible[0], irreversible: true } : null;
}

function checkFile(file, dir, guard, stateDir) {
  if (inStateFolder(file, dir, stateDir)) return 'access to the mission state folder';
  const name = path.basename(file);
  return isSecretName(name, guard) ? `access to secret file ${name}` : null;
}

// The patterns of a Grep glob, split on spaces and on commas outside braces: `*.{js,ts}` stays whole.
function globPieces(glob) {
  const pieces = [];
  let piece = '';
  let braces = 0;
  for (const char of glob) {
    if (char === '{') braces++;
    if (char === '}' && braces > 0) braces--;
    if (/\s/.test(char) || (char === ',' && braces === 0)) {
      if (piece) pieces.push(piece);
      piece = '';
    } else {
      piece += char;
    }
  }
  if (piece) pieces.push(piece);
  return pieces;
}

// True when `folder` is the state folder or one of its parents, and not in a worktree of a mission
// (`<project>/.relaylead/worktrees/<id>`).
function holdsStateFolder(folder, stateDir) {
  if (!stateDir) return false;
  const parts = path.resolve(folder).split(path.sep);
  const inWorktree = parts.some((part, i) => part === '.relaylead' && parts[i + 1] === 'worktrees' && parts[i + 2]);
  return !inWorktree && reaches(stateDir, folder);
}

// Reason to refuse a write to `file` (seen from `dir`), or null. Only the real path lets a write
// through: a link in the working folder that points out of it is out of it. The Relaylead folder is
// refused first, so the exception of Claude Code's temporary folder never opens it, even when it lies there.
function writeRefusal(file, dir, workDir) {
  const target = path.resolve(dir, expandHome(file));
  if (reaches(target, home())) return `write in the Relaylead folder ${home()}`;
  const real = realPath(target);
  if (workDir && isInside(real, realPath(workDir))) return null;
  const temp = claudeTempDir();
  if (temp && isInside(real, realPath(temp))) return null;
  return workDir ? `write outside the working folder ${workDir}` : 'write by a session that has no working folder';
}

// The part of a glob before its first segment with a wildcard: `~/.ssh/*` gives `~/.ssh`.
function globBase(glob) {
  const segments = glob.split(/[\\/]/);
  const first = segments.findIndex((segment) => /[*?[{]/.test(segment));
  if (first === -1) return glob;
  return segments.slice(0, first).join('/') || (glob.startsWith('/') ? '/' : '.');
}

// Reason to refuse a read of `file` (seen from `dir`), or null: the files of keys and tokens of the
// home folder, the configuration and the API key of Relaylead, and the missions' state folders.
function readRefusal(file, dir) {
  const target = path.resolve(dir, expandHome(file));
  const sensitive = [
    ...SENSITIVE_IN_HOME.map((name) => path.join(os.homedir(), name)),
    path.join(home(), 'config.json'),
    path.join(home(), 'api-key'),
    path.join(home(), 'missions'),
  ];
  const found = sensitive.find((place) => reaches(target, place));
  return found ? `read of sensitive location ${found}` : null;
}

// `stateDir` is the mission's state folder: sessions change it only through the relaylead CLI.
// Glob and Grep also name files by a glob, seen from their `path` (or `cwd`). Glob's `pattern` is
// judged for the state folder only: Glob gives names and reads nothing. Grep's `glob` is judged
// for the state folder and the secrets: Grep reads the files it names, and in ripgrep `*` also
// matches `.env`.
// Grep's `glob` may hold several patterns (`*.js .env`, `*.js,.env`): each one is judged, and one
// that names a secret or the state folder refuses the whole call. A Grep without `glob` whose `path`
// is the state folder or one of its parents (the home folder, say) would search it: refused, unless
// that path is in a worktree of the mission. Without `path`, Grep searches its cwd, judged as a path.
// Known gap: a glob with no folder part (`*.json`) and a `path` that is a parent of the state folder
// is let through; refusing it would block every search in the home folder.
// Read, Grep and Glob never reach the sensitive locations of readRefusal (Glob: its `path` and the
// folder part of its pattern). With `confine` (the hooks always give it), Write, Edit and
// NotebookEdit stay in `confine.workDir`, the session's working folder (null: the session has none,
// as the lead), or in Claude Code's temporary folder. These two refusals carry `advice`.
function checkToolUse({ tool_name, tool_input, cwd }, guard, stateDir = null, confine = null) {
  const input = tool_input || {};
  const dir = cwd || process.cwd();
  let reason = null;
  let irreversible = false;
  if (tool_name === 'Bash') ({ reason, irreversible } = checkBash(String(input.command || ''), dir, guard, stateDir) || {});
  const field = FILE_TOOLS.get(tool_name);
  if (field && input[field]) reason = checkFile(String(input[field]), dir, guard, stateDir);
  const searched = input.path ? path.resolve(dir, expandHome(String(input.path))) : dir;
  if (!reason && tool_name === 'Glob' && input.pattern) {
    reason = checkFileWord(String(input.pattern), searched, { ...guard, secrets: [] }, stateDir);
  }
  if (!reason && tool_name === 'Grep' && input.glob) {
    for (const piece of globPieces(String(input.glob))) {
      reason = reason || checkFileWord(piece, searched, guard, stateDir, true);
    }
  }
  if (!reason && tool_name === 'Grep' && !input.glob && input.path && holdsStateFolder(searched, stateDir)) {
    reason = 'access to the mission state folder';
  }
  if (reason && irreversible) return { decision: 'deny', reason, irreversible: true };
  if (reason) return { decision: 'deny', reason };
  let advised = null;
  if (['Read', 'Grep', 'Glob'].includes(tool_name)) {
    const places = tool_name === 'Read' ? [input.file_path] : [searched, tool_name === 'Glob' && input.pattern ? path.resolve(searched, expandHome(globBase(String(input.pattern)))) : null];
    for (const place of places.filter(Boolean)) advised = advised || readRefusal(String(place), dir);
    if (advised) return { decision: 'deny', reason: advised, advice: READ_ADVICE };
  }
  if (confine && WRITE_TOOLS.includes(tool_name) && input[field]) {
    advised = writeRefusal(String(input[field]), dir, confine.workDir);
    if (advised) return { decision: 'deny', reason: advised, advice: WRITE_ADVICE };
  }
  return { decision: 'allow' };
}

// The text an answer of the user is about: a Bash command with its words joined by one space, the
// file of a file tool, the whole input of any other tool.
function actionText({ tool_name, tool_input }) {
  const input = tool_input || {};
  if (tool_name === 'Bash') return String(input.command || '').trim().split(/\s+/).join(' ');
  const field = FILE_TOOLS.get(tool_name);
  return field && input[field] ? String(input[field]) : JSON.stringify(input);
}

// The id of an action in the keys of its questions (irr-<hash>, perm-<hash>): 12 hex characters.
function actionHash(toolName, text) {
  return crypto.createHash('sha256').update(`${toolName}\0${text}`).digest('hex').slice(0, 12);
}

// `cat <<EOF` alone only prints its heredoc, as in `git commit -m "$(cat <<'EOF' … )"`: it reads nothing.
function isHeredocPrint({ words, redirects }) {
  return words.length === 1 && words[0] === 'cat' && redirects.every((r) => /^<<[^<]/.test(r));
}

// Claude-style patterns: `Read` allows any use of Read; `Bash(git *)` allows the Bash commands
// that match. Every piece must match a pattern, including the commands run by `$(…)`.
function isAllowed({ tool_name, tool_input }, patterns) {
  if (patterns.includes(tool_name)) return true;
  if (tool_name !== 'Bash') return false;
  const globs = patterns
    .filter((pattern) => pattern.startsWith('Bash(') && pattern.endsWith(')'))
    .map((pattern) => pattern.slice('Bash('.length, -1));
  const texts = bashCommands((tool_input || {}).command || '')
    .flat()
    .filter((piece) => piece.words.length > 0 && !isHeredocPrint(piece))
    .map((piece) => [...piece.words, ...piece.redirects].join(' '));
  return texts.length > 0 && texts.every((text) => globs.some((glob) => globMatch(glob, text)));
}

// With `questionId`, the user was asked about the action; with `answered` too, the user refused it,
// or its one-time permission is used: asking again changes nothing.
function denyMessage(reason, questionId = null, answered = false) {
  if (answered) {
    return `Blocked by Relaylead: ${reason}. The user refused it or its one-time permission is already used (question ${questionId}): do not retry this command, continue with the rest of the task, one command per call.`;
  }
  const asked = questionId ? `Asked the user (question ${questionId}), continue` : 'Continue';
  return `Blocked by Relaylead: ${reason}. ${asked} with the rest of the task, one command per call.`;
}

// --- Hook helpers -----------------------------------------------------------------------------

// A guard key that is not a list of texts falls back to its default, so a wrong config never
// makes the hooks crash (a crashing hook lets the action through).
function cleanGuard(guard) {
  const result = {};
  for (const [key, fallback] of Object.entries(DEFAULTS.guard)) {
    const value = guard && guard[key];
    const valid = Array.isArray(value) && value.every((item) => typeof item === 'string');
    result[key] = valid ? value : fallback;
  }
  return result;
}

// The working folder of the crew member of task `id`: its output folder for the files delivery,
// its worktree otherwise (deliveries/*.js, prepareTask). Null when it cannot be told.
function taskWorkDir(mission, id) {
  if (!id || !/^[^\\/]+$/.test(id) || id === '.' || id === '..') return null;
  try {
    const files = ((mission.config || {}).delivery || {}).type === 'files';
    return files ? layout.outDir(mission, id) : layout.taskDir(mission, id);
  } catch {
    return null;
  }
}

// The guard of the mission named by RELAYLEAD_MISSION, its state folder, and the working folder of
// the session (RELAYLEAD_TASK names a crew member's task; a lead has none). Without a readable
// mission, the default guard: protected pushes are refused even then. `mission` is null when the
// mission is unknown.
function loadMissionGuard() {
  const name = process.env.RELAYLEAD_MISSION;
  if (!name || !/^[a-z0-9-]+$/.test(name)) return { mission: null, guard: DEFAULTS.guard, stateDir: null, workDir: null };
  const stateDir = missionDir(name);
  try {
    const mission = readJson(path.join(stateDir, 'mission.json'), null);
    if (mission) {
      const workDir = taskWorkDir(mission, process.env.RELAYLEAD_TASK);
      return { mission: name, guard: cleanGuard((mission.config || {}).guard), stateDir, workDir };
    }
  } catch {
    // Unreadable mission.json: default guard.
  }
  return { mission: null, guard: DEFAULTS.guard, stateDir, workDir: null };
}

// The hook input sent by Claude Code on stdin, or null when it is not a JSON object.
function readHookInput() {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    return input && typeof input === 'object' && !Array.isArray(input) ? input : null;
  } catch {
    return null;
  }
}

// One line per refusal, appended (never rewritten). Called after the decision is printed, so a
// failing journal never changes the decision.
function writeJournal(mission, tool, reason) {
  if (!mission) return;
  try {
    const line = `${new Date().toISOString()} ${tool || 'unknown'} ${reason}\n`;
    fs.appendFileSync(path.join(missionDir(mission), 'journal.log'), line, { mode: 0o600 });
  } catch {
    // The journal is a record only; the decision is already made.
  }
}

module.exports = {
  checkToolUse,
  isAllowed,
  actionText,
  actionHash,
  denyMessage,
  loadMissionGuard,
  readHookInput,
  writeJournal,
};
