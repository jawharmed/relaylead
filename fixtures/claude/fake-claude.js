// A fake `claude` CLI for the adapter tests. It replays the outputs recorded from Claude Code 2.1.325
// (launch-*.txt and stop-*.txt next to this file) and keeps its sessions in FAKE_CLAUDE_STATE/sessions.json,
// so `agents --json --all`, `stop`, `attach`, `--bg` and `--bg --resume` agree with each other.
// Each session gets a real process (a small sleeper), so `stop` really ends something: it writes the
// sleeper's stop file, and the sleeper ends by itself. As it exits, the sleeper writes its ended file
// (FAKE_CLAUDE_STATE/ended-<sleeper>), which says it has ended. Nothing is killed, nor judged alive,
// by pid: on Windows, the pid of a process that has ended soon belongs to another one, maybe of another
// test file.
//
// FAKE_CLAUDE_SCENARIO: a comma-separated list of these (default: normal)
//   normal                  launches start working; a resume wakes the session if its process has ended
//   old-version             `--version` answers 2.1.300
//   untrusted               a launch answers "Workspace not trusted"
//   unknown-output          a launch answers something without an id
//   never-started           a launch backgrounds a session left waiting for a prompt (recorded row)
//   unknown-state           a launch backgrounds a session in a state this version does not know
//   unknown-state-busy      the same, but running a turn
//   done-at-launch          a launch backgrounds a session that is already done (its process lives on)
//   working-idle            a launch backgrounds a session left working whose turn has ended (row seen after done)
//   pid-late                a launch backgrounds a working session that the first `agents` lists without a pid
//   pid-never               a launch backgrounds a working session that `agents` always lists without a pid
//   wake-copy               a resume always starts a copy (first recorded copy output)
//   wake-copy-2             a resume always starts a copy (second recorded copy output)
//   stuck-stop              `stop` marks the session stopped but its process keeps running
//   unstoppable             sessions started now cannot be stopped (`stop` fails, the process keeps running)
//   hang-agents             `agents` never answers
//   noisy                   every command also writes a warning on stderr
//   agents-fail-after-wake  `agents` fails once a session has been woken
//   agents-fail-after-one   `agents` answers once, then fails
//   plugin-fail             `plugin list` fails
//   plugin-install-fail     `plugin install` fails
//   rm-fail                 `rm` fails for a known session
// `[--settings JSON] auth status --json` answers like Claude Code 2.1.330: apiKeySource
// ANTHROPIC_API_KEY when that variable is set, apiKeyHelper when the settings have one, else the
// connected account. It never runs the helper.
// `plugin ...` commands keep the marketplaces and plugins in FAKE_CLAUDE_STATE/plugins.json. Each call
// writes the ANTHROPIC_API_KEY it got in FAKE_CLAUDE_STATE/env.log ("-" when unset): a test passes it a
// made-up value, never a real key.
// Every call is appended to FAKE_CLAUDE_STATE/calls.log (one JSON array of arguments per line). A test
// ends every sleeper it started by writing FAKE_CLAUDE_STATE/stop-all.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { writeJson, readJson, withWindowsRetry } = require('../../core/store');

const STATE_DIR = process.env.FAKE_CLAUDE_STATE;
const SCENARIO = new Set((process.env.FAKE_CLAUDE_SCENARIO || 'normal').split(','));
const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');
const WOKE_MARKER = path.join(STATE_DIR, 'woke');
const LISTED_MARKER = path.join(STATE_DIR, 'listed');
const STOP_ALL = path.join(STATE_DIR, 'stop-all');

// Usage: node -e SLEEPER <own ended file> <own stop file> <stop-all file>. Once one of the stop files
// exists (read every 50 ms), it lingers 300 ms, like a real session finishing its last write, and
// ends. It also ends by itself after two minutes, so a crashed test leaves nothing behind for long.
// However it ends, it writes its ended file as it exits.
const SLEEPER = `
const fs = require('node:fs');
const [endedFile, ...stopFiles] = process.argv.slice(1);
process.on('exit', () => fs.writeFileSync(endedFile, ''));
const lifetime = setTimeout(() => {}, 120000);
const watch = setInterval(() => {
  if (!stopFiles.some((file) => fs.existsSync(file))) return;
  clearInterval(watch);
  clearTimeout(lifetime);
  setTimeout(() => {}, 300);
}, 50);
`;

// Through core/store: the write is atomic and both sides retry when Windows denies the file for a moment.
function readSessions() {
  return readJson(SESSIONS_FILE, []);
}

function writeSessions(sessions) {
  writeJson(SESSIONS_FILE, sessions);
}

function appendLog(name, line) {
  withWindowsRetry(() => fs.appendFileSync(path.join(STATE_DIR, name), line));
}

function recorded(name) {
  return fs.readFileSync(path.join(__dirname, name), 'utf8');
}

function stopFile(sleeper) {
  return path.join(STATE_DIR, `stop-${sleeper}`);
}

function endedFile(sleeper) {
  return path.join(STATE_DIR, `ended-${sleeper}`);
}

// A row with a pid whose sleeper has not written its ended file. Like the real CLI, a row without a
// pid has no process.
function hasProcess(session) {
  return Boolean(session.pid && session.sleeper) && !fs.existsSync(endedFile(session.sleeper));
}

// Returns the fields of a row for its process: `pid`, and `sleeper`, which names its stop file (not a
// field of the real CLI). A new name for each sleeper: a woken session keeps its id, not its stop file.
function startSleeper() {
  const sleeper = crypto.randomBytes(4).toString('hex');
  const child = spawn(process.execPath, ['-e', SLEEPER, endedFile(sleeper), stopFile(sleeper), STOP_ALL], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return { pid: child.pid, sleeper };
}

// Same fields as a recorded row of `claude agents --json --all`.
function newSession(name, state, status) {
  const id = crypto.randomBytes(4).toString('hex');
  const session = {
    ...startSleeper(),
    id,
    cwd: process.cwd(),
    kind: 'background',
    startedAt: Date.now(),
    sessionId: `${id}-1111-4222-8333-444455556666`,
    name,
    status,
    state,
  };
  if (SCENARIO.has('unstoppable')) session.unstoppable = true;
  return session;
}

function launch(args) {
  if (SCENARIO.has('untrusted')) {
    // The recorded text names the folder of the launch.
    process.stdout.write(recorded('launch-untrusted.txt').replace('/path/to/dir', process.cwd()));
    return 1;
  }
  if (SCENARIO.has('unknown-output')) {
    process.stdout.write(recorded('launch-unknown.txt'));
    return 1;
  }
  const name = args[args.indexOf('--name') + 1];
  let session = newSession(name, 'working', 'busy');
  if (SCENARIO.has('never-started')) session = { ...session, status: 'idle', state: 'blocked' };
  if (SCENARIO.has('unknown-state')) session = { ...session, status: 'idle', state: 'starting' };
  if (SCENARIO.has('unknown-state-busy')) session = { ...session, state: 'starting' };
  if (SCENARIO.has('done-at-launch')) session = { ...session, status: 'idle', state: 'done' };
  if (SCENARIO.has('working-idle')) session = { ...session, status: 'idle' };
  // `latePid` is not a field of the real CLI: the pid that the next `agents` shows.
  if (SCENARIO.has('pid-late')) session = { ...session, pid: undefined, latePid: session.pid };
  if (SCENARIO.has('pid-never')) session = { ...session, pid: undefined };
  writeSessions([...readSessions(), session]);
  process.stdout.write(recorded('launch-ok.txt').replace(/0f0b2950/g, session.id).replace('demo-mission/lead/1', name));
  return 0;
}

function copyOutput(copy, originalId) {
  if (SCENARIO.has('wake-copy-2')) {
    return recorded('launch-copy-2.txt').replace('8805d640', copy.id).replace('0f0b2950', originalId);
  }
  return recorded('launch-copy.txt').replace(/0334d933/g, copy.id).replace('6a25653f', originalId);
}

// Like the real CLI: a resume with options, or of a session whose process still runs, starts a copy.
function resume(args) {
  const sessions = readSessions();
  const original = sessions.find((session) => session.sessionId === args[2]);
  const withoutOptions = args.length === 4 && args[0] === '--bg' && args[1] === '--resume';
  const forcedCopy = SCENARIO.has('wake-copy') || SCENARIO.has('wake-copy-2');
  if (!original || forcedCopy || !withoutOptions || hasProcess(original)) {
    const copy = newSession('resumed-copy', 'working', 'busy');
    writeSessions([...sessions, copy]);
    process.stdout.write(copyOutput(copy, original ? original.id : 'unknown0'));
    return 0;
  }
  Object.assign(original, { ...startSleeper(), status: 'busy', state: 'working' });
  writeSessions(sessions);
  writeJson(WOKE_MARKER, original.id);
  process.stdout.write(recorded('launch-wake.txt').replace('0f0b2950', original.id));
  return 0;
}

// Recorded: `stopped <id>` with exit 0, even when already stopped; the row then has no pid nor status.
function stop(shortId) {
  const sessions = readSessions();
  const session = sessions.find((candidate) => candidate.id === shortId);
  if (!session) {
    process.stdout.write(recorded('stop-unknown.txt').replace('deadbeef', shortId));
    return 1;
  }
  if (session.unstoppable) {
    // Not recorded: any failure of the real CLI, with the session still running.
    process.stderr.write('Error: the background service did not answer\n');
    return 1;
  }
  if (!SCENARIO.has('stuck-stop') && session.sleeper) fs.writeFileSync(stopFile(session.sleeper), '');
  delete session.pid;
  delete session.sleeper;
  delete session.status;
  session.state = 'stopped';
  writeSessions(sessions);
  process.stdout.write(recorded('stop-ok.txt').replace('0f0b2950', shortId));
  return 0;
}

function agents() {
  if (SCENARIO.has('hang-agents')) {
    setTimeout(() => {}, 60000); // killed by the adapter's timeout
    return 0;
  }
  if (SCENARIO.has('agents-fail-after-wake') && fs.existsSync(WOKE_MARKER)) {
    process.stderr.write('Error: the background service did not answer\n');
    return 1;
  }
  if (SCENARIO.has('agents-fail-after-one') && fs.existsSync(LISTED_MARKER)) {
    process.stderr.write('Error: the background service did not answer\n');
    return 1;
  }
  writeJson(LISTED_MARKER, true);
  const sessions = readSessions();
  process.stdout.write(JSON.stringify(sessions) + '\n');
  if (sessions.some((session) => session.latePid)) {
    writeSessions(sessions.map(({ latePid, ...session }) => (latePid ? { ...session, pid: latePid } : session)));
  }
  return 0;
}

// `plugin marketplace add|remove|list`, `plugin install|uninstall|list`. Strict like Claude Code: adding
// what is there, or removing what is not, fails. `plugin-install-fail` makes `plugin install` fail.
function plugin(args) {
  const file = path.join(STATE_DIR, 'plugins.json');
  const state = readJson(file, { marketplaces: [], plugins: [] });
  const [verb, argument] = args;
  const fail = (text) => {
    process.stderr.write(`Error: ${text}\n`);
    return 1;
  };
  if (verb === 'marketplace') {
    if (args[1] === 'list') {
      process.stdout.write(JSON.stringify(state.marketplaces.map((name) => ({ name }))) + '\n');
      return 0;
    }
    if (args[1] === 'add') {
      const name = readJson(path.join(args[2], '.claude-plugin', 'marketplace.json'), { name: args[2] }).name;
      if (state.marketplaces.includes(name)) return fail(`marketplace ${name} already exists`);
      state.marketplaces.push(name);
    } else {
      if (!state.marketplaces.includes(args[2])) return fail(`marketplace ${args[2]} not found`);
      state.marketplaces = state.marketplaces.filter((known) => known !== args[2]);
    }
  } else if (verb === 'install') {
    if (SCENARIO.has('plugin-install-fail')) return fail('could not install');
    if (state.plugins.includes(argument)) return fail(`${argument} is already installed`);
    state.plugins.push(argument);
  } else if (verb === 'uninstall') {
    if (!state.plugins.includes(argument)) return fail(`${argument} is not installed`);
    state.plugins = state.plugins.filter((id) => id !== argument);
  } else if (verb === 'list') {
    if (SCENARIO.has('plugin-fail')) return fail('plugin list failed');
    process.stdout.write(JSON.stringify(state.plugins.map((id) => ({ id, version: '0.1.0', scope: 'user', enabled: true }))) + '\n');
    return 0;
  } else {
    return fail(`unexpected plugin arguments ${JSON.stringify(args)}`);
  }
  writeJson(file, state);
  process.stdout.write('ok\n');
  return 0;
}

function authStatus(args) {
  const at = args.indexOf('--settings');
  const settings = at === -1 ? {} : JSON.parse(args[at + 1]);
  let status = { loggedIn: true, authMethod: 'claude.ai' };
  if (process.env.ANTHROPIC_API_KEY) status = { loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' };
  else if (settings.apiKeyHelper) status = { loggedIn: true, authMethod: 'api_key_helper', apiKeySource: 'apiKeyHelper' };
  process.stdout.write(JSON.stringify(status, null, 2) + '\n');
  return 0;
}

// Removes a session from the list. An unknown id: the answer of Claude Code 2.1.330, exit 1.
function rm(shortId) {
  const sessions = readSessions();
  if (!sessions.some((session) => session.id === shortId)) {
    process.stdout.write(`No session matching '${shortId}'\n`);
    return 1;
  }
  if (SCENARIO.has('rm-fail')) {
    process.stderr.write('Error: the background service did not answer\n');
    return 1;
  }
  writeSessions(sessions.filter((session) => session.id !== shortId));
  process.stdout.write(`Removed ${shortId}\n`);
  return 0;
}

function main(args) {
  appendLog('calls.log', JSON.stringify(args) + '\n');
  appendLog('env.log', (process.env.ANTHROPIC_API_KEY || '-') + '\n');
  if (SCENARIO.has('noisy')) process.stderr.write('warning: this is a noisy fake\n');
  if (args[0] === '--version') {
    process.stdout.write(SCENARIO.has('old-version') ? '2.1.300 (Claude Code)\n' : '2.1.325 (Claude Code)\n');
    return 0;
  }
  if (args[0] === 'plugin') return plugin(args.slice(1));
  if (args[0] === 'agents') return agents();
  if (args[0] === 'stop') return stop(args[1]);
  if (args[0] === 'rm') return rm(args[1]);
  if (args.includes('auth')) return authStatus(args);
  // Silent: attach inherits the terminal, and the calls log is enough for the tests.
  if (args[0] === 'attach') return 0;
  if (args.includes('--resume')) return resume(args);
  if (args.includes('--bg')) return launch(args);
  process.stderr.write(`fake claude: unexpected arguments ${JSON.stringify(args)}\n`);
  return 2;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  // An unexpected failure must explain itself: the adapter only shows our stderr.
  process.stderr.write(`fake claude: ${err.message}\n${err.stack}\n`);
  process.exitCode = 70;
}
