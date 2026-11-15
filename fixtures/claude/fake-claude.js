// A fake `claude` CLI for the adapter tests. It replays the outputs recorded during the spike
// (launch-*.txt next to this file) and keeps its sessions in FAKE_CLAUDE_STATE/sessions.json, so
// `agents --json --all`, `stop`, `attach`, `--bg` and `--bg --resume` agree with each other.
// Each session gets a real process (a small sleeper), so `stop` really ends something.
//
// FAKE_CLAUDE_SCENARIO:
//   normal (default)  launches start working; a resume wakes the session if its process has ended
//   old-version       `--version` answers 2.1.300
//   untrusted         a launch answers "Workspace not trusted"
//   unknown-output    a launch answers something without an id
//   never-started     a launch backgrounds a session that stays waiting for a prompt
//   wake-copy         a resume always starts a copy
//   stuck-stop        `stop` marks the session stopped but its process keeps running
// Every call is appended to FAKE_CLAUDE_STATE/calls.log (one JSON array of arguments per line).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const STATE_DIR = process.env.FAKE_CLAUDE_STATE;
const SCENARIO = process.env.FAKE_CLAUDE_SCENARIO || 'normal';
const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');

// The sleeper ends by itself after two minutes, so a crashed test leaves nothing behind for long.
// On a stop it lingers 300 ms, like a real session finishing its last write (no signal handlers on Windows).
const SLEEPER = "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300)); setTimeout(() => {}, 120000);";

function readSessions() {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeSessions(sessions) {
  const tmp = `${SESSIONS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2));
  fs.renameSync(tmp, SESSIONS_FILE);
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
  return child.pid;
}

function newSession(name, state) {
  const id = crypto.randomBytes(4).toString('hex');
  return {
    id,
    sessionId: `${id}-1111-4222-8333-444455556666`,
    name,
    state,
    status: state === 'working' ? 'busy' : 'idle',
    pid: startSleeper(),
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
  };
}

function launch(args) {
  if (SCENARIO === 'untrusted') {
    // The recorded text names the folder of the launch.
    process.stdout.write(recorded('launch-untrusted.txt').replace('/tmp/some project', process.cwd()));
    return 1;
  }
  if (SCENARIO === 'unknown-output') {
    process.stdout.write(recorded('launch-unknown.txt'));
    return 1;
  }
  const name = args[args.indexOf('--name') + 1];
  const session = newSession(name, SCENARIO === 'never-started' ? 'blocked' : 'working');
  writeSessions([...readSessions(), session]);
  process.stdout.write(recorded('launch-ok.txt').replace('0f0b2950', session.id).replace('demo-mission/lead/1', name));
  return 0;
}

// Like the real CLI: a resume with options, or of a session whose process still runs, starts a copy.
function resume(args) {
  const sessions = readSessions();
  const original = sessions.find((session) => session.sessionId === args[2]);
  const withoutOptions = args.length === 4 && args[0] === '--bg' && args[1] === '--resume';
  if (!original || SCENARIO === 'wake-copy' || !withoutOptions || isAlive(original.pid)) {
    const copy = newSession('resumed-copy', 'working');
    writeSessions([...sessions, copy]);
    const originalId = original ? original.id : 'unknown0';
    process.stdout.write(recorded('launch-copy.txt').replace(/0334d933/g, copy.id).replace('6a25653f', originalId));
    return 0;
  }
  original.pid = startSleeper();
  original.state = 'working';
  writeSessions(sessions);
  process.stdout.write(recorded('launch-wake.txt').replace('0f0b2950', original.id));
  return 0;
}

function stop(shortId) {
  const sessions = readSessions();
  const session = sessions.find((candidate) => candidate.id === shortId);
  if (!session) {
    process.stdout.write(`No session found matching ${shortId}\n`);
    return 1;
  }
  if (SCENARIO !== 'stuck-stop' && isAlive(session.pid)) process.kill(session.pid);
  session.state = 'stopped';
  writeSessions(sessions);
  process.stdout.write(`stopped ${shortId}\n`);
  return 0;
}

function main(args) {
  fs.appendFileSync(path.join(STATE_DIR, 'calls.log'), JSON.stringify(args) + '\n');
  if (args[0] === '--version') {
    process.stdout.write(SCENARIO === 'old-version' ? '2.1.300 (Claude Code)\n' : '2.1.325 (Claude Code)\n');
    return 0;
  }
  if (args[0] === 'agents') {
    process.stdout.write(JSON.stringify(readSessions()) + '\n');
    return 0;
  }
  if (args[0] === 'stop') return stop(args[1]);
  // Silent: attach inherits the terminal, and the calls log is enough for the tests.
  if (args[0] === 'attach') return 0;
  if (args.includes('--resume')) return resume(args);
  if (args.includes('--bg')) return launch(args);
  process.stderr.write(`fake claude: unexpected arguments ${JSON.stringify(args)}\n`);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
