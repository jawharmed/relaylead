// A fake `claude` CLI for the adapter tests. It replays the outputs recorded from Claude Code 2.1.325
// (launch-*.txt and stop-*.txt next to this file) and keeps its sessions in FAKE_CLAUDE_STATE/sessions.json,
// so `agents --json --all`, `stop`, `attach`, `--bg` and `--bg --resume` agree with each other.
// Each session gets a real process (a small sleeper), so `stop` really ends something.
//
// FAKE_CLAUDE_SCENARIO: a comma-separated list of these (default: normal)
//   normal                  launches start working; a resume wakes the session if its process has ended
//   old-version             `--version` answers 2.1.300
//   untrusted               a launch answers "Workspace not trusted"
//   unknown-output          a launch answers something without an id
//   never-started           a launch backgrounds a session left waiting for a prompt (recorded row)
//   unknown-state           a launch backgrounds a session in a state this version does not know
//   done-at-launch          a launch backgrounds a session that is already done (its process lives on)
//   working-idle            a launch backgrounds a session left working whose turn has ended (row seen after done)
//   wake-copy               a resume always starts a copy (first recorded copy output)
//   wake-copy-2             a resume always starts a copy (second recorded copy output)
//   stuck-stop              `stop` marks the session stopped but its process keeps running
//   unstoppable             sessions started now cannot be stopped (`stop` fails, the process keeps running)
//   hang-agents             `agents` never answers
//   noisy                   every command also writes a warning on stderr
//   agents-fail-after-wake  `agents` fails once a session has been woken
// Every call is appended to FAKE_CLAUDE_STATE/calls.log (one JSON array of arguments per line), and
// every process started to FAKE_CLAUDE_STATE/pids.log, so the tests can kill them all.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { writeJson, readJson, withWindowsRetry } = require('../../core/store');

const STATE_DIR = process.env.FAKE_CLAUDE_STATE;
const SCENARIO = new Set((process.env.FAKE_CLAUDE_SCENARIO || 'normal').split(','));
const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');
const WOKE_MARKER = path.join(STATE_DIR, 'woke');

// The sleeper ends by itself after two minutes, so a crashed test leaves nothing behind for long.
// On a stop it lingers 300 ms, like a real session finishing its last write (no signal handlers on Windows).
const SLEEPER = "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300)); setTimeout(() => {}, 120000);";

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

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function startSleeper() {
  const child = spawn(process.execPath, ['-e', SLEEPER], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  appendLog('pids.log', `${child.pid}\n`);
  return child.pid;
}

// Same fields as a recorded row of `claude agents --json --all`.
function newSession(name, state, status) {
  const id = crypto.randomBytes(4).toString('hex');
  const session = {
    pid: startSleeper(),
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
  if (SCENARIO.has('done-at-launch')) session = { ...session, status: 'idle', state: 'done' };
  if (SCENARIO.has('working-idle')) session = { ...session, status: 'idle' };
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
  if (!original || forcedCopy || !withoutOptions || isAlive(original.pid)) {
    const copy = newSession('resumed-copy', 'working', 'busy');
    writeSessions([...sessions, copy]);
    process.stdout.write(copyOutput(copy, original ? original.id : 'unknown0'));
    return 0;
  }
  Object.assign(original, { pid: startSleeper(), status: 'busy', state: 'working' });
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
  if (!SCENARIO.has('stuck-stop') && isAlive(session.pid)) process.kill(session.pid);
  delete session.pid;
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
  process.stdout.write(JSON.stringify(readSessions()) + '\n');
  return 0;
}

function main(args) {
  appendLog('calls.log', JSON.stringify(args) + '\n');
  if (SCENARIO.has('noisy')) process.stderr.write('warning: this is a noisy fake\n');
  if (args[0] === '--version') {
    process.stdout.write(SCENARIO.has('old-version') ? '2.1.300 (Claude Code)\n' : '2.1.325 (Claude Code)\n');
    return 0;
  }
  if (args[0] === 'agents') return agents();
  if (args[0] === 'stop') return stop(args[1]);
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
