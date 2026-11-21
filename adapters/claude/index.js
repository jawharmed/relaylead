// Claude adapter: runs each session as a background `claude --bg` session (recipes: docs/spike-results.md).
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { missionDir } = require('../../core/paths');
const { readJson } = require('../../core/store');
const { t, codedError } = require('../../core/messages');
const { listSessions, isAlive, settleBoundMs } = require('../../core/sessions');
const { MIN_VERSION, buildLaunchArgs, compareVersion } = require('./args');
const { writeSessionSettings } = require('./settings');
const { parseLaunchOutput, mapState } = require('./sessions');
const { sleep } = require('../../core/timing');
const { loadConfig } = require('../../core/config');
const { apiKeyEnv } = require('../../core/auth');

const PACKAGE_DIR = path.join(__dirname, '..', '..');
const POLL_MS = 250;
// The version found, per command: `claude --version` runs once per process.
const versions = {};

// Delays, read at call time so tests can shorten them.
function delayMs(name, fallback) {
  return Number(process.env[name]) || fallback;
}
const startTimeoutMs = () => delayMs('RELAYLEAD_CLAUDE_START_MS', 30000); // first turn begun
const wakeTimeoutMs = () => delayMs('RELAYLEAD_CLAUDE_WAKE_MS', 60000); // process ended after a stop
const commandTimeoutMs = () => delayMs('RELAYLEAD_CLAUDE_COMMAND_MS', 30000); // agents, stop, --version
const launchTimeoutMs = () => delayMs('RELAYLEAD_CLAUDE_LAUNCH_MS', 120000); // --bg and --bg --resume

function findOnPath(file) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, file))) return path.join(dir, file);
  }
  return null;
}

// The program to run and the arguments that come before claude's own.
// Never through a shell: it would break the quotes of the prompts. Node cannot run a Windows
// `.cmd` or `.bat` without a shell, so on Windows only a real `claude.exe` is accepted.
function claudeCommand() {
  const chosen = process.env.RELAYLEAD_CLAUDE;
  if (chosen && /\.(cmd|bat)$/i.test(chosen)) throw codedError('claude-cmd-unsupported', { file: chosen });
  if (chosen && chosen.endsWith('.js')) return { file: process.execPath, prefix: [chosen] };
  if (chosen) return { file: chosen, prefix: [] };
  if (process.platform !== 'win32') return { file: 'claude', prefix: [] };
  const exe = findOnPath('claude.exe');
  if (exe) return { file: exe, prefix: [] };
  const cmd = findOnPath('claude.cmd');
  if (cmd) throw codedError('claude-cmd-unsupported', { file: cmd });
  throw codedError('claude-not-found', {});
}

// Runs `claude <args>` and resolves with its exit code, stdout and stderr. After `timeoutMs`, Node
// kills it and the call fails with `claude-timeout` naming `label`.
function runClaude(args, { cwd, env, label = `claude ${args.join(' ')}`, timeoutMs = commandTimeoutMs() } = {}) {
  const { file, prefix } = claudeCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...prefix, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // Our own timer, not spawn's `timeout`: when claude does not exist, spawn's timer keeps the process alive.
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? codedError('claude-not-found', {}) : err);
    });
    child.once('exit', () => {
      // `killed` is only set by the timeout. A process it started may still hold the pipes: stop reading them.
      if (!child.killed) return;
      child.stdout.destroy();
      child.stderr.destroy();
      reject(codedError('claude-timeout', { command: label, seconds: timeoutMs / 1000 }));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// The environment of a launch or a wake: ours, plus the API key in `api-key` mode (core/auth.js is
// the only reader of the key). Not used by the calls that only list or stop sessions.
function sessionEnv() {
  return { ...process.env, ...apiKeyEnv(loadConfig()) };
}

function failed(command, { stdout, stderr }) {
  return codedError('claude-failed', { command, output: (stdout + stderr).trim() });
}

async function checkVersion() {
  const { file, prefix } = claudeCommand();
  const key = [file, ...prefix].join(' ');
  if (!(key in versions)) {
    const result = await runClaude(['--version']);
    if (result.code !== 0) throw failed('claude --version', result);
    versions[key] = result.stdout.trim();
  }
  if (!compareVersion(versions[key], MIN_VERSION)) {
    throw codedError('claude-too-old', { found: versions[key] || 'unknown', min: MIN_VERSION });
  }
  return versions[key];
}

// A prompt starting with "-" would be read by claude as an option.
function checkPrompt(text, what) {
  if (String(text).startsWith('-')) throw codedError('bad-prompt', { what });
}

// Every row of `claude agents --json --all`.
async function agentRows() {
  const command = 'claude agents --json --all';
  const result = await runClaude(['agents', '--json', '--all']);
  if (result.code !== 0) throw failed(command, result);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw codedError('claude-unexpected-output', { command, output: result.stdout.trim() });
  }
}

async function findRow(shortId) {
  return (await agentRows()).find((row) => row.id === shortId) || null;
}

// Read on the raw row: mapState takes an unknown state for working. A prompt swallowed by an
// option leaves the session "blocked" and "idle" (spike, point 2g).
function hasStarted(row) {
  return ['working', 'done', 'failed'].includes(row.state) || row.status === 'busy';
}

// The row of a session once it has begun its first turn, or null after the timeout. claude may list
// a working session before its pid (seen for a lead): within the same timeout, the row is read again
// until it has one, and is returned without one at the end or when a read fails: it has started.
// A done or failed row needs no pid: a failed one has no process.
async function waitUntilStarted(shortId) {
  const deadline = Date.now() + startTimeoutMs();
  let started = null;
  for (;;) {
    let row;
    try {
      row = await findRow(shortId);
    } catch (err) {
      if (started) return started;
      throw err;
    }
    if (row && hasStarted(row)) {
      if (row.pid || ['done', 'failed'].includes(row.state)) return row;
      started = row;
    }
    if (Date.now() >= deadline) return started;
    await sleep(POLL_MS);
  }
}

// Stops the session a failed launch or wake left behind, and says on the error whether it worked:
// `stoppedKey` names the message added when it did. If not, err.orphan is the session still running.
// The CLI prints err.suffix again in the user's language.
async function stopAfterFailure(err, shortId, stoppedKey) {
  try {
    await stop({ shortId });
    err.suffix = { key: stoppedKey, vars: { shortId } };
  } catch {
    err.orphan = shortId;
    err.suffix = { key: 'orphan', vars: { shortId } };
  }
  err.message += t(err.suffix.key, err.suffix.vars);
  return err;
}

async function launch(spec) {
  checkPrompt(spec.prompt, 'prompt');
  await checkVersion();
  const mission = readJson(path.join(missionDir(spec.mission), 'mission.json'), null);
  if (!mission) throw codedError('mission-unknown', { mission: spec.mission });
  const settingsFile = writeSessionSettings({
    mission,
    packageDir: PACKAGE_DIR,
    profile: spec.profile,
    permissionMode: spec.permissionMode,
    sessionName: spec.name,
    env: spec.env,
  });
  const args = buildLaunchArgs({
    profile: spec.profile,
    name: spec.name,
    settingsFile,
    permissionMode: spec.permissionMode,
    prompt: spec.prompt,
  });
  const { stdout, stderr } = await runClaude(args, { cwd: spec.cwd, env: sessionEnv(), label: 'claude --bg', timeoutMs: launchTimeoutMs() });
  const output = stdout + stderr;
  const result = parseLaunchOutput(output);
  if (result.error === 'untrusted-dir') throw codedError('untrusted-dir', { dir: spec.cwd });
  if (!result.shortId) throw codedError('claude-unexpected-output', { command: 'claude --bg', output: output.trim() });

  // From here a session exists: any failure stops it, or says it could not.
  let row;
  try {
    row = await waitUntilStarted(result.shortId);
  } catch (err) {
    throw await stopAfterFailure(err, result.shortId, 'session-stopped');
  }
  if (!row) {
    const err = codedError('not-started', { shortId: result.shortId, seconds: startTimeoutMs() / 1000 });
    throw await stopAfterFailure(err, result.shortId, 'session-stopped');
  }
  return { ...mapState(row), name: spec.name, role: spec.role };
}

// The mission's sessions as claude reports them. A session claude does not list (yet) is left out:
// the watcher gives it a grace period. `idle` says claude runs no turn of the session: a session may
// stay "working" once its turn has ended. Only the helper that stops the lead after `done` reads it.
async function list(mission) {
  const known = new Set(listSessions(mission).map((session) => session.shortId));
  if (known.size === 0) return [];
  return (await agentRows())
    .filter((row) => known.has(row.id))
    .map((row) => ({ ...mapState(row), idle: row.status === 'idle' }));
}

// `claude stop` exits 0 even for a session already stopped. Any other exit is fine when the session
// no longer runs: unknown to claude ("No job matching") or without a live process. Its state is not
// enough: a done session keeps a live process.
async function stop(session) {
  const result = await runClaude(['stop', session.shortId]);
  if (result.code === 0) return;
  const row = await findRow(session.shortId);
  if (!row || !isAlive(row.pid)) return;
  throw failed(`claude stop ${session.shortId}`, result);
}

// No timeout: the user stays attached as long as they like. A session ended by a signal gives 1.
async function attach(session) {
  const { file, prefix } = claudeCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...prefix, 'attach', session.shortId], { stdio: 'inherit' });
    child.once('error', (err) => reject(err.code === 'ENOENT' ? codedError('claude-not-found', {}) : err));
    child.once('close', (code) => resolve(code === null ? 1 : code));
  });
}

// Resuming a session whose process still runs, or with any option, starts a copy (spike): so stop,
// wait for the session to end, then resume with nothing but the message, from the session folder.
async function wake(session, message) {
  checkPrompt(message, 'message');
  const row = await findRow(session.shortId);
  // The pid to wait for: the listed one. Without one (a wake run again after one that gave up, or
  // within the 1.5 s when the row has lost its pid, measured fact 1), the registry pid, as a fallback
  // that may by now belong to another process: it gets the short bound on every system.
  const listedPid = row ? row.pid : null;
  await stop(session);
  await waitUntilEnded(session, listedPid || session.pid, settleBoundMs(wakeTimeoutMs(), { fallback: !listedPid }));
  const args = ['--bg', '--resume', session.sessionId, message];
  const { stdout, stderr } = await runClaude(args, { cwd: session.cwd, env: sessionEnv(), label: 'claude --bg --resume', timeoutMs: launchTimeoutMs() });
  const output = stdout + stderr;
  const result = parseLaunchOutput(output);
  if (result.error === 'untrusted-dir') throw codedError('untrusted-dir', { dir: session.cwd });
  if (!result.shortId) throw codedError('claude-unexpected-output', { command: 'claude --bg --resume', output: output.trim() });
  if (result.shortId !== session.shortId) {
    const err = codedError('wake-copy', { shortId: session.shortId, copy: result.shortId });
    throw await stopAfterFailure(err, result.shortId, 'copy-stopped');
  }
  return wokenSession(session);
}

// The end of a stopped session, in two steps: its row has no pid (or is gone), then `pid`, read
// before the stop, has ended; the row loses its pid up to 1.5 s before the process ends (measured
// fact 1). Within the wait of wakeTimeoutMs, the second step lasts at most `settleMs`
// (settleBoundMs), which for a listed pid only shortens it on Windows: on macOS the resume never
// starts before that process has ended, which would start a copy. A read of the row that fails
// leaves that round to the pid alone. Fails with wake-timeout once the wait is over.
async function waitUntilEnded(session, pid, settleMs) {
  const deadline = Date.now() + wakeTimeoutMs();
  let unlistedAt = null;
  for (;;) {
    let listed; // whether claude lists a process for the session; undefined when the read fails
    try {
      const row = await findRow(session.shortId);
      listed = Boolean(row && row.pid);
    } catch {
      listed = undefined; // `claude agents` may fail for a moment
    }
    const now = Date.now();
    if (listed) unlistedAt = null;
    else if (listed === false && unlistedAt === null) unlistedAt = now;
    if (!listed && !isAlive(pid)) return;
    if (now >= deadline) throw codedError('wake-timeout', { shortId: session.shortId, seconds: wakeTimeoutMs() / 1000 });
    if (listed === false && now - unlistedAt >= settleMs) return;
    await sleep(POLL_MS);
  }
}

// The woken session as claude lists it. The wake has worked: a failing list must not undo it.
async function wokenSession(session) {
  try {
    const row = await findRow(session.shortId);
    if (row) return { ...mapState(row), name: session.name, role: session.role };
  } catch {
    // fall back to what is known
  }
  return { ...session, state: 'working', pid: null };
}

module.exports = {
  name: 'claude',
  claudeCommand,
  checkVersion,
  capabilities: ['launch', 'list', 'stop', 'attach', 'wake'],
  // `claude stop <id>` is harmless on a session already stopped: `relaylead stop` may run again.
  stopById: true,
  launch,
  list,
  stop,
  attach,
  wake,
};
