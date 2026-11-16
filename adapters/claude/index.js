// Claude adapter: runs each session as a background `claude --bg` session (recipes: docs/spike-results.md).
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { missionDir } = require('../../core/paths');
const { readJson } = require('../../core/store');
const { t, codedError } = require('../../core/messages');
const { listSessions, isAlive } = require('../../core/sessions');
const { MIN_VERSION, buildLaunchArgs, compareVersion } = require('./args');
const { writeSessionSettings } = require('./settings');
const { parseLaunchOutput, mapState } = require('./sessions');

const PACKAGE_DIR = path.join(__dirname, '..', '..');
const POLL_MS = 250;
// The version found, per command: `claude --version` runs once per process.
const versions = {};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
function runClaude(args, { cwd, label = `claude ${args.join(' ')}`, timeoutMs = commandTimeoutMs() } = {}) {
  const { file, prefix } = claudeCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...prefix, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', (err) => reject(err.code === 'ENOENT' ? codedError('claude-not-found', {}) : err));
    child.once('exit', () => {
      // `killed` is only set by the timeout. A process it started may still hold the pipes: stop reading them.
      if (!child.killed) return;
      child.stdout.destroy();
      child.stderr.destroy();
      reject(codedError('claude-timeout', { command: label, seconds: timeoutMs / 1000 }));
    });
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
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

// The row of a session once it has begun its first turn, or null after the timeout.
async function waitUntilStarted(shortId) {
  const deadline = Date.now() + startTimeoutMs();
  for (;;) {
    const row = await findRow(shortId);
    if (row && hasStarted(row)) return row;
    if (Date.now() >= deadline) return null;
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
  const { stdout, stderr } = await runClaude(args, { cwd: spec.cwd, label: 'claude --bg', timeoutMs: launchTimeoutMs() });
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
// the watcher gives it a grace period.
async function list(mission) {
  const known = new Set(listSessions(mission).map((session) => session.shortId));
  if (known.size === 0) return [];
  return (await agentRows()).filter((row) => known.has(row.id)).map(mapState);
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
// wait for the process to end, then resume with nothing but the message, from the session folder.
async function wake(session, message) {
  checkPrompt(message, 'message');
  const row = await findRow(session.shortId);
  // A row without a pid has no process: the registry pid may by now belong to another process.
  const pid = row ? row.pid : session.pid;
  await stop(session);
  const deadline = Date.now() + wakeTimeoutMs();
  while (isAlive(pid)) {
    if (Date.now() >= deadline) throw codedError('wake-timeout', { shortId: session.shortId, seconds: wakeTimeoutMs() / 1000 });
    await sleep(POLL_MS);
  }
  const args = ['--bg', '--resume', session.sessionId, message];
  const { stdout, stderr } = await runClaude(args, { cwd: session.cwd, label: 'claude --bg --resume', timeoutMs: launchTimeoutMs() });
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
  capabilities: ['launch', 'list', 'stop', 'attach', 'wake'],
  // `claude stop <id>` is harmless on a session already stopped: `relaylead stop` may run again.
  stopById: true,
  launch,
  list,
  stop,
  attach,
  wake,
};
