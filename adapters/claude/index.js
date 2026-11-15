// Claude adapter: runs each session as a background `claude --bg` session (recipes: docs/spike-results.md).
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { missionDir } = require('../../core/paths');
const { readJson } = require('../../core/store');
const { codedError } = require('../../core/messages');
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

// Read at call time so tests can shorten them.
function startTimeoutMs() {
  return Number(process.env.RELAYLEAD_CLAUDE_START_MS) || 30000;
}

function wakeTimeoutMs() {
  return Number(process.env.RELAYLEAD_CLAUDE_WAKE_MS) || 60000;
}

function findOnPath(file) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, file))) return path.join(dir, file);
  }
  return null;
}

// The program to run and the arguments that come before claude's own.
// Never through a shell: it would break the quotes of the prompts. Node cannot run a Windows
// `.cmd` without a shell, so on Windows only a real `claude.exe` is accepted.
function claudeCommand() {
  const chosen = process.env.RELAYLEAD_CLAUDE;
  if (chosen && chosen.endsWith('.js')) return { file: process.execPath, prefix: [chosen] };
  if (chosen) return { file: chosen, prefix: [] };
  if (process.platform !== 'win32') return { file: 'claude', prefix: [] };
  const exe = findOnPath('claude.exe');
  if (exe) return { file: exe, prefix: [] };
  if (findOnPath('claude.cmd')) throw codedError('claude-cmd-unsupported', {});
  throw codedError('claude-not-found', {});
}

// Runs `claude <args>` and resolves with its exit code and everything it printed.
function runClaude(args, { cwd, env } = {}) {
  const { file, prefix } = claudeCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...prefix, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.once('error', (err) => reject(err.code === 'ENOENT' ? codedError('claude-not-found', {}) : err));
    child.once('close', (code) => resolve({ code, output }));
  });
}

async function checkVersion() {
  const { file, prefix } = claudeCommand();
  const key = [file, ...prefix].join(' ');
  if (!(key in versions)) versions[key] = (await runClaude(['--version'])).output.trim();
  if (!compareVersion(versions[key], MIN_VERSION)) {
    throw codedError('claude-too-old', { found: versions[key] || 'unknown', min: MIN_VERSION });
  }
}

// Every row of `claude agents --json --all`.
async function agentRows() {
  const { output } = await runClaude(['agents', '--json', '--all']);
  try {
    return JSON.parse(output);
  } catch {
    throw codedError('claude-unexpected-output', { command: 'claude agents --json --all', output: output.trim() });
  }
}

async function findRow(shortId) {
  return (await agentRows()).find((row) => row.id === shortId) || null;
}

// The row of a session once it has begun its first turn, or null after the timeout. A prompt
// swallowed by an option leaves the session waiting for a prompt (spike, point 2g).
async function waitUntilStarted(shortId) {
  const deadline = Date.now() + startTimeoutMs();
  for (;;) {
    const row = await findRow(shortId);
    if (row && mapState(row).state !== 'waiting') return row;
    if (Date.now() >= deadline) return null;
    await sleep(POLL_MS);
  }
}

async function launch(spec) {
  await checkVersion();
  const mission = readJson(path.join(missionDir(spec.mission), 'mission.json'), null);
  if (!mission) throw codedError('mission-unknown', { mission: spec.mission });
  const settingsFile = writeSessionSettings({
    mission,
    packageDir: PACKAGE_DIR,
    profile: spec.profile,
    permissionMode: spec.permissionMode,
    sessionName: spec.name,
  });
  const args = buildLaunchArgs({
    profile: spec.profile,
    name: spec.name,
    settingsFile,
    permissionMode: spec.permissionMode,
    prompt: spec.prompt,
  });
  const { output } = await runClaude(args, { cwd: spec.cwd, env: spec.env });
  const result = parseLaunchOutput(output);
  if (result.error === 'untrusted-dir') throw codedError('untrusted-dir', { dir: spec.cwd });
  if (!result.shortId) throw codedError('claude-unexpected-output', { command: 'claude --bg', output: output.trim() });

  // From here a session exists: any failure stops it, so no session is left running unreported.
  try {
    const row = await waitUntilStarted(result.shortId);
    if (!row) throw codedError('not-started', { shortId: result.shortId, seconds: startTimeoutMs() / 1000 });
    return { ...mapState(row), name: spec.name, role: spec.role };
  } catch (err) {
    await stopQuietly(result.shortId);
    throw err;
  }
}

// Keeps the first error: it says what went wrong, not the cleanup.
async function stopQuietly(shortId) {
  try {
    await stop({ shortId });
  } catch {
    // ignored on purpose
  }
}

// The mission's sessions as claude reports them. A session claude does not list (yet) is left out:
// the watcher gives it a grace period.
async function list(mission) {
  const known = new Set(listSessions(mission).map((session) => session.shortId));
  return (await agentRows()).filter((row) => known.has(row.id)).map(mapState);
}

async function stop(session) {
  const { code, output } = await runClaude(['stop', session.shortId]);
  if (code === 0 || /already stopped|not found|no session/i.test(output)) return;
  throw codedError('claude-failed', { command: `claude stop ${session.shortId}`, output: output.trim() });
}

function attach(session) {
  const { file, prefix } = claudeCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...prefix, 'attach', session.shortId], { stdio: 'inherit' });
    child.once('error', (err) => reject(err.code === 'ENOENT' ? codedError('claude-not-found', {}) : err));
    child.once('close', (code) => resolve(code));
  });
}

// Resuming a session whose process still runs, or with any option, starts a copy (spike): so stop,
// wait for the process to end, then resume with nothing but the message, from the session folder.
async function wake(session, message) {
  const row = await findRow(session.shortId);
  const pid = row ? row.pid : session.pid;
  await stop(session);
  const deadline = Date.now() + wakeTimeoutMs();
  while (isAlive(pid)) {
    if (Date.now() >= deadline) throw codedError('wake-timeout', { shortId: session.shortId, seconds: wakeTimeoutMs() / 1000 });
    await sleep(POLL_MS);
  }
  const { output } = await runClaude(['--bg', '--resume', session.sessionId, message], { cwd: session.cwd });
  const result = parseLaunchOutput(output);
  if (result.error === 'untrusted-dir') throw codedError('untrusted-dir', { dir: session.cwd });
  if (!result.shortId) throw codedError('claude-unexpected-output', { command: 'claude --bg --resume', output: output.trim() });
  if (result.shortId !== session.shortId) {
    await stopQuietly(result.shortId);
    throw codedError('wake-copy', { shortId: session.shortId, copy: result.shortId });
  }
  const woken = await findRow(session.shortId);
  return woken ? { ...mapState(woken), name: session.name, role: session.role } : { ...session, state: 'working' };
}

module.exports = {
  name: 'claude',
  capabilities: ['launch', 'list', 'stop', 'attach', 'wake'],
  launch,
  list,
  stop,
  attach,
  wake,
};
