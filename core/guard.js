// The guard: crew sessions run with broad permissions and nobody watching, so some actions are
// refused whatever the permission mode (protected or forced pushes, commits on a protected branch,
// secret files). Used by the hooks in core/hooks/.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { missionDir } = require('./paths');
const { readJson } = require('./store');
const { DEFAULTS } = require('./config');

// `*` matches any characters; everything else is literal and case-sensitive.
function globMatch(pattern, text) {
  const parts = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('.*')}$`, 's').test(text);
}

// Last part of a path, with / or \ as separator whatever the system.
function baseName(file) {
  return file.split(/[\\/]/).pop();
}

// Claude judges a compound command as one block, so each piece is judged on its own. Splitting
// inside quotes is harmless: it only makes more pieces to judge. `2>&1` and `&>` are redirections,
// not a background `&`: they become `>` so they do not cut the command.
function splitCommand(command) {
  return String(command)
    .replace(/>&|&>/g, '>')
    .split(/[;&|\r\n]/)
    .map((piece) => piece.trim())
    .filter(Boolean);
}

// Words of a command piece without their quotes: `git -C "my dir" push` gives git, -C, my dir, push.
function words(piece) {
  const result = [];
  let current = null;
  let quote = null;
  for (const char of piece) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      current = current ?? '';
    } else if (/\s/.test(char)) {
      if (current !== null) result.push(current);
      current = null;
    } else {
      current = (current ?? '') + char;
    }
  }
  if (current !== null) result.push(current);
  return result;
}

// The branch checked out in `dir`, or null when unknown (not a repository, detached HEAD).
function currentBranch(dir) {
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

function isProtected(branch, guard) {
  return branch !== null && guard.protectedBranches.some((pattern) => globMatch(pattern, branch));
}

// `[VAR=value…] git [-C dir] [-c key=value] <subcommand> args…`: the subcommand, its arguments
// and the folder git works in. Null when the piece is not a git command.
function parseGit(pieceWords, cwd) {
  let i = 0;
  while (i < pieceWords.length && /^\w+=/.test(pieceWords[i])) i++;
  if (!['git', 'git.exe'].includes(baseName(pieceWords[i] || ''))) return null;
  let dir = cwd;
  i++;
  while (i < pieceWords.length && pieceWords[i].startsWith('-')) {
    if (pieceWords[i] === '-C') dir = path.resolve(dir, pieceWords[i + 1] || '');
    i += pieceWords[i] === '-C' || pieceWords[i] === '-c' ? 2 : 1;
  }
  if (i >= pieceWords.length) return null;
  return { subcommand: pieceWords[i], args: pieceWords.slice(i + 1), dir };
}

// Branch a refspec writes to: `main`, `HEAD:main`, `src:refs/heads/main`, `:main` (delete) all give main.
function destination(refspec, dir) {
  const [source, target] = refspec.replace(/^\+/, '').split(':');
  const branch = (target || source).replace(/^refs\/heads\//, '');
  return branch === 'HEAD' ? currentBranch(dir) : branch;
}

function checkPush(args, dir, guard) {
  const positional = [];
  for (const arg of args) {
    if (arg === '--all' || arg === '--mirror') return 'push of every branch';
    // --force, --force-with-lease[=…], and -f alone or grouped with other short options (-uf).
    if (/^--force(-with-lease)?(=|$)/.test(arg) || /^-[^-]*f/.test(arg)) return 'force push';
    if (!arg.startsWith('-')) positional.push(arg);
  }
  const refspecs = positional.slice(1); // the first one is the remote
  if (refspecs.some((refspec) => refspec.startsWith('+'))) return 'force push';
  // Without a refspec, git pushes the current branch.
  const branches = refspecs.length ? refspecs.map((refspec) => destination(refspec, dir)) : [currentBranch(dir)];
  if (branches.some((branch) => branch !== null && branch.includes('*'))) return 'push of a branch pattern';
  const hit = branches.find((branch) => isProtected(branch, guard));
  return hit ? `push to protected branch ${hit}` : null;
}

// Returns the matched file name, or null.
function secretIn(names, guard) {
  for (const name of names) {
    const base = baseName(name);
    if (base && guard.secrets.some((pattern) => globMatch(pattern, base))) return base;
  }
  return null;
}

// Reason to refuse one piece of a Bash command, or null.
function checkPiece(piece, cwd, guard) {
  const pieceWords = words(piece);
  // `--env-file=.env` and `<.env` also name the file.
  const secret = secretIn(pieceWords.flatMap((word) => word.split(/[<>=]/)), guard);
  if (secret) return `access to secret file ${secret}`;

  const git = parseGit(pieceWords, cwd);
  if (!git) return null;
  if (git.subcommand === 'push') return checkPush(git.args, git.dir, guard);
  if (git.subcommand === 'commit') {
    const branch = currentBranch(git.dir);
    if (isProtected(branch, guard)) return `commit on protected branch ${branch}`;
  }
  return null;
}

function checkToolUse({ tool_name, tool_input, cwd }, guard) {
  const input = tool_input || {};
  let reason = null;
  if (['Read', 'Write', 'Edit'].includes(tool_name)) {
    const secret = secretIn([String(input.file_path || '')], guard);
    if (secret) reason = `access to secret file ${secret}`;
  }
  if (tool_name === 'Bash') {
    // Subshells, `$(…)`, `(…)` and backticks, are cut out too: what they run is judged on its own.
    for (const piece of splitCommand(String(input.command || '').replace(/[()`]/g, ';'))) {
      reason = checkPiece(piece, cwd || process.cwd(), guard);
      if (reason) break;
    }
  }
  return reason ? { decision: 'deny', reason } : { decision: 'allow' };
}

// Claude-style patterns: `Read` allows any use of Read; `Bash(git *)` allows the Bash commands
// that match. A compound command is allowed only if every piece matches a pattern.
function isAllowed({ tool_name, tool_input }, patterns) {
  if (patterns.includes(tool_name)) return true;
  if (tool_name !== 'Bash') return false;
  const globs = patterns
    .filter((pattern) => pattern.startsWith('Bash(') && pattern.endsWith(')'))
    .map((pattern) => pattern.slice('Bash('.length, -1));
  const command = String((tool_input || {}).command || '');
  // A subshell runs commands that the pattern does not see: only a bare `Bash` allows it.
  if (/`|[$<>]\(/.test(command)) return false;
  const pieces = splitCommand(command);
  return pieces.length > 0 && pieces.every((piece) => globs.some((glob) => globMatch(glob, piece)));
}

function denyMessage(reason) {
  return `Blocked by Relaylead: ${reason}. Continue with the rest of the task, one command per call.`;
}

// The guard of the mission named by RELAYLEAD_MISSION. Without a readable mission, the default
// guard: protected pushes are refused even then. `mission` is null when the mission is unknown.
function loadMissionGuard() {
  const name = process.env.RELAYLEAD_MISSION;
  if (name && /^[a-z0-9-]+$/.test(name)) {
    try {
      const mission = readJson(path.join(missionDir(name), 'mission.json'), null);
      if (mission) return { mission: name, guard: { ...DEFAULTS.guard, ...(mission.config || {}).guard } };
    } catch {
      // Unreadable mission.json: default guard.
    }
  }
  return { mission: null, guard: DEFAULTS.guard };
}

// The hook input sent by Claude Code on stdin, or null when it is not a JSON object.
function readHookInput() {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    return input && typeof input === 'object' ? input : null;
  } catch {
    return null;
  }
}

// One line per refusal, appended (never rewritten). Called after the decision is printed, so a
// failing journal never changes the decision.
function writeJournal(mission, tool, reason) {
  if (!mission) return;
  try {
    fs.appendFileSync(path.join(missionDir(mission), 'journal.log'), `${new Date().toISOString()} ${tool} ${reason}\n`);
  } catch {
    // The journal is a record only; the decision is already made.
  }
}

module.exports = { checkToolUse, isAllowed, denyMessage, loadMissionGuard, readHookInput, writeJournal };
