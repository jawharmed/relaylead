// The guard: crew sessions run with broad permissions and nobody watching, so some actions are
// refused whatever the permission mode: protected or forced pushes, commits on a protected branch,
// secret files, and the mission's own state folder. Used by the hooks in core/hooks/.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { home, missionDir } = require('./paths');
const { readJson } = require('./store');
const { DEFAULTS } = require('./config');

// File names that differ only by case are the same file on macOS and Windows.
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

// The branch of a folder reached through `cd $DIR` or `cd -`: only known when the shell runs.
const COMPUTED = '$computed';

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
]);

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

// End of the line that closes a heredoc started on the line ending at `lineEnd`, or -1 when no
// line closes it. A line we take for the closing one too early only makes more lines judged.
function heredocEnd(text, lineEnd, delimiter) {
  let start = lineEnd + 1;
  while (start <= text.length) {
    const end = text.indexOf('\n', start) === -1 ? text.length : text.indexOf('\n', start);
    if (text.slice(start, end).replace(/^\t+/, '') === delimiter) return end;
    start = end + 1;
  }
  return -1;
}

// A heredoc that feeds `git commit` is the commit message: data, not commands, so its body is
// dropped. Only a real heredoc counts: `<<` outside quotes (a `$( … )` starts afresh, even inside
// double quotes) and a closing line that exists. Other heredoc bodies stay and are judged line by
// line, like commands, but they are skipped when looking for quotes: the shell does not read
// quotes there.
function dropCommitMessages(command) {
  let text = command;
  const open = []; // open quotes and `$(`, innermost last
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const inside = open[open.length - 1];
    if (inside === "'") {
      if (char === "'") open.pop();
    } else if (char === '\\') {
      i++;
    } else if (char === '$' && text[i + 1] === '(') {
      open.push('(');
      i++;
    } else if (inside === '"') {
      if (char === '"') open.pop();
    } else if (char === '"' || char === "'") {
      open.push(char);
    } else if (char === ')' && inside === '(') {
      open.pop();
    } else if (char === '<' && text[i - 1] !== '<') {
      const heredoc = /^<<-?\s*(['"]?)\\?([A-Za-z_][\w-]*)\1/.exec(text.slice(i));
      const lineEnd = text.indexOf('\n', i);
      const end = heredoc && lineEnd !== -1 ? heredocEnd(text, lineEnd, heredoc[2]) : -1;
      if (end === -1) continue;
      const line = text.slice(text.lastIndexOf('\n', i) + 1, lineEnd);
      if (/\bgit\b.*\bcommit\b/.test(line)) {
        text = text.slice(0, lineEnd) + text.slice(end);
        i = lineEnd - 1;
      } else {
        i = end - 1;
      }
    }
  }
  return text;
}

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

// Splits a command into pieces: {words, redirects, end}. Quotes are removed and a backslash
// escapes the next character, as in the shell. A piece ends at ; & && | || ( ) or a newline outside
// quotes; `end` keeps which one. A redirection keeps its operator (`>/dev/null`, `<.env`) and goes to
// `redirects`; the descriptor number of `2>&1` is dropped. Splitting more than the shell does
// is harmless: it only makes more pieces to judge.
function splitPieces(text) {
  const pieces = [];
  let words = [];
  let redirects = [];
  let word = null;
  let quote = null;
  let redirecting = false;
  const endWord = () => {
    if (word !== null) (redirecting ? redirects : words).push(word);
    word = null;
    redirecting = false;
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
    } else if (char === '\\' && next !== undefined && (!quote || '$`"\\\n'.includes(next))) {
      i++;
      if (next !== '\n') word = (word ?? '') + next;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      word = word ?? '';
    } else if (char === '<' || char === '>' || (char === '&' && next === '>')) {
      if (word !== null && /^\d+$/.test(word)) word = null;
      endWord();
      word = char;
      while (text[i + 1] !== undefined && '<>&'.includes(text[i + 1])) word += text[++i];
      while (text[i + 1] === ' ' || text[i + 1] === '\t') i++;
      redirecting = true;
    } else if (char === '&' || char === '|') {
      const double = next === char;
      if (double || (char === '|' && next === '&')) i++;
      endPiece(double ? char + char : char);
    } else if (';()\r\n'.includes(char)) {
      endPiece(char === '\r' ? '\n' : char);
    } else if (/\s/.test(char)) {
      endWord();
    } else {
      word = (word ?? '') + char;
    }
  }
  endPiece('');
  return pieces;
}

// Every command of a Bash call, each as a list of pieces: the substitutions, then the main one.
function bashCommands(command) {
  return cutSubstitutions(dropCommitMessages(String(command))).map(splitPieces);
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

// `target` seen from `dir`; null when only the shell knows it (a variable, `cd -`, an unknown dir).
function moveTo(dir, target) {
  const expanded = expandHome(target);
  if (dir === null || target === '-' || /[$`]/.test(expanded)) return null;
  return path.resolve(dir, expanded);
}

// The branch checked out in `dir`: null when there is none (not a repository, detached HEAD),
// COMPUTED when the folder itself is unknown.
function currentBranch(dir) {
  if (dir === null) return COMPUTED;
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return branch === 'HEAD' ? null : branch;
  } catch {
    return null;
  }
}

// Reason to refuse `action` ('push to', 'commit on') on `branch`, or null.
function branchRefusal(action, branch, guard) {
  if (branch === null) return null;
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

// True when `name` is a secret file name, or a glob that may match one.
function isSecretName(name, guard) {
  if (guard.secretExceptions.some((pattern) => globMatch(pattern, name, CASE_INSENSITIVE))) return false;
  if (!/[*?[]/.test(name)) return guard.secrets.some((pattern) => globMatch(pattern, name, CASE_INSENSITIVE));
  // A glob may match a secret when one matches an example of the other. Like the shell, a
  // leading wildcard does not match a name that starts with a dot.
  const word = shellGlobRegExp(name);
  const wordExample = name.replace(/\[[^\]]*\]|[*?]/g, 'x');
  return guard.secrets.some((pattern) => {
    const examples = [pattern.replace(/\*/g, ''), pattern.replace(/\*/g, 'x')];
    const hidesDotFiles = /^[*?[]/.test(name);
    const meets = examples.some((example) => word.test(example) && !(hidesDotFiles && example.startsWith('.')));
    return meets || globMatch(pattern, wordExample, CASE_INSENSITIVE);
  });
}

// True when `file` is in the state folder. A path through another variable cannot be resolved:
// it counts as inside when it names the state folders (`.relaylead` or `missions`).
function inStateFolder(word, dir, stateDir) {
  if (!stateDir || !word) return false;
  const file = expandHome(word);
  if (/[$`]/.test(file)) return /\.relaylead|missions/i.test(file);
  if (dir === null && !path.isAbsolute(file)) return false;
  const normalize = (p) => (CASE_INSENSITIVE ? p.toLowerCase() : p);
  const full = normalize(path.resolve(dir || '', file));
  const folder = normalize(path.resolve(stateDir));
  return full === folder || full.startsWith(folder + path.sep);
}

// Reason to refuse a file named in a Bash word, or null. `--env-file=.env` names .env too.
function checkFileWord(word, dir, guard, stateDir) {
  for (const part of word.replace(/^[<>&]+/, '').split('=')) {
    if (inStateFolder(part, dir, stateDir)) return 'access to the mission state folder';
    const name = path.posix.basename(part);
    if (name && isSecretName(name, guard)) return `access to secret file ${name}`;
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
// or inside `( … )` does not move the pieces after it.
function checkBash(command, cwd, guard, stateDir) {
  for (const pieces of bashCommands(command)) {
    let dirs = [cwd];
    let beforeChain = null; // the folders before a `cd … &&` chain
    let previousEnd = '';
    const groups = [];
    for (const piece of pieces) {
      for (const dir of dirs) {
        const reason = checkPiece(piece, dir, guard, stateDir);
        if (reason) return reason;
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

function checkFile(file, dir, guard, stateDir) {
  if (inStateFolder(file, dir, stateDir)) return 'access to the mission state folder';
  const name = path.basename(file);
  return isSecretName(name, guard) ? `access to secret file ${name}` : null;
}

// `stateDir` is the mission's state folder: sessions change it only through the relaylead CLI.
function checkToolUse({ tool_name, tool_input, cwd }, guard, stateDir = null) {
  const input = tool_input || {};
  const dir = cwd || process.cwd();
  let reason = null;
  if (tool_name === 'Bash') reason = checkBash(input.command || '', dir, guard, stateDir);
  const field = FILE_TOOLS.get(tool_name);
  if (field && input[field]) reason = checkFile(String(input[field]), dir, guard, stateDir);
  return reason ? { decision: 'deny', reason } : { decision: 'allow' };
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

function denyMessage(reason) {
  return `Blocked by Relaylead: ${reason}. Continue with the rest of the task, one command per call.`;
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

// The guard of the mission named by RELAYLEAD_MISSION and its state folder. Without a readable
// mission, the default guard: protected pushes are refused even then. `mission` is null when the
// mission is unknown.
function loadMissionGuard() {
  const name = process.env.RELAYLEAD_MISSION;
  if (!name || !/^[a-z0-9-]+$/.test(name)) return { mission: null, guard: DEFAULTS.guard, stateDir: null };
  const stateDir = missionDir(name);
  try {
    const mission = readJson(path.join(stateDir, 'mission.json'), null);
    if (mission) return { mission: name, guard: cleanGuard((mission.config || {}).guard), stateDir };
  } catch {
    // Unreadable mission.json: default guard.
  }
  return { mission: null, guard: DEFAULTS.guard, stateDir };
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
    fs.appendFileSync(path.join(missionDir(mission), 'journal.log'), line);
  } catch {
    // The journal is a record only; the decision is already made.
  }
}

module.exports = { checkToolUse, isAllowed, denyMessage, loadMissionGuard, readHookInput, writeJournal };
