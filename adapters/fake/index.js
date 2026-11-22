// Fake adapter: each session is a small Node process (agent.js), so tests need no real agent.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { home, missionDir } = require('../../core/paths');
const { listSessions, isAlive } = require('../../core/sessions');
const { withWindowsRetry } = require('../../core/store');
const { codedError } = require('../../core/messages');
const { sleep } = require('../../core/timing');

const AGENT = path.join(__dirname, 'agent.js');
// How long a wake waits for the stopped session to end; read at call time so tests can shorten it.
const wakeTimeoutMs = () => Number(process.env.RELAYLEAD_FAKE_WAKE_MS) || 10000;

// The two files of a session's end (adapters/fake/watch-stop.js). The stop file asks the agent to
// end; it is outside the mission folder, which a failed launch removes while its lead may still run,
// and it is removed once the session has ended. The ended file says the agent has ended; it stays in
// the mission folder, and goes with it. Both paths are chosen at launch and kept in the session
// record (fields the core ignores), so a stop or a list made under another RELAYLEAD_HOME still finds
// them; a session recorded without them (by a test) gets the paths of the current home.
function stopFile(session) {
  return session.stopFile || path.join(home(), 'fake', `${session.shortId}.stop`);
}

function endedFile(session) {
  return missionFile(session, 'endedFile', 'ended');
}

// Two more files in the mission folder, kept in the record the same way. The idle file is written by
// the agent when it ends its turn and stays alive (agent.js, endTurn). The killed file is the witness
// of a death without an end, which the killed session cannot write itself: the test that kills it
// writes it (fixtures/helpers.js, killSession).
function idleFile(session) {
  return missionFile(session, 'idleFile', 'idle');
}

function killedFile(session) {
  return missionFile(session, 'killedFile', 'killed');
}

function missionFile(session, field, extension) {
  return session[field] || path.join(missionDir(session.name.split('/')[0]), `fake-${session.shortId}.${extension}`);
}

// The pid of the session as the registry has it now, found by its short id: after a wake, an object
// read before it still names the old process, dead. The given one when the registry has no record
// of it (a stop made under another RELAYLEAD_HOME).
function currentPid(session) {
  const recorded = listSessions(session.name.split('/')[0]).find((candidate) => candidate.shortId === session.shortId);
  return (recorded || session).pid;
}

function sessionFiles(session) {
  return { stopFile: stopFile(session), endedFile: endedFile(session), idleFile: idleFile(session), killedFile: killedFile(session) };
}

// Starts the agent process of a session, detached, with `files` given in its env.
async function startAgent(role, cwd, env, files) {
  const child = spawn(process.execPath, [AGENT, role], {
    cwd,
    env: {
      ...env,
      RELAYLEAD_FAKE_STOP: files.stopFile,
      RELAYLEAD_FAKE_ENDED: files.endedFile,
      RELAYLEAD_FAKE_IDLE: files.idleFile,
      RELAYLEAD_FAKE_SHORT_ID: files.shortId,
    },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  // Without an 'error' listener, a failed start would crash the whole process.
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  return child.pid;
}

async function launch(spec) {
  const hex = crypto.randomBytes(8).toString('hex');
  const sessionId = 'fake-' + hex;
  const shortId = hex.slice(0, 8);
  const files = sessionFiles({ shortId, name: spec.name });
  // Where the agent writes its failures, so a test that times out can show them.
  const logFile = path.join(missionDir(spec.mission), `fake-${spec.role}-${shortId}.log`);
  // Like a real session, it gets no task from the process that launched it, only from spec.env.
  const env = { ...process.env, RELAYLEAD_TASK: undefined, ...spec.env, RELAYLEAD_FAKE_LOG: logFile };
  const pid = await startAgent(spec.role, spec.cwd, env, { ...files, shortId });
  // spec.env is kept so a wake starts the agent again with it.
  return { sessionId, shortId, name: spec.name, role: spec.role, state: 'working', pid, cwd: spec.cwd, ...files, logFile, env: spec.env };
}

// A session is judged on the files of its end first: its pid may by now belong to another process,
// which is not to be waited for. Killed (its witness) or ended (its agent wrote it): no process.
// Then a dead pid is a sure proof (only a live pid can mislead, #62): failed, no process. Otherwise
// the session lives: done and idle with its process once it has ended its turn, as Claude lists it
// (measured facts 1 and 2), working before.
async function list(mission) {
  return listSessions(mission).map((session) => {
    if (fs.existsSync(killedFile(session))) return { ...session, state: 'failed', pid: null, idle: true };
    if (fs.existsSync(endedFile(session))) return { ...session, state: 'done', pid: null, idle: true };
    if (!isAlive(session.pid)) return { ...session, state: 'failed', pid: null, idle: true };
    if (fs.existsSync(idleFile(session))) return { ...session, state: 'done', idle: true };
    return { ...session, state: 'working', idle: false };
  });
}

// Asks the session to end; its agent sees the file within 50 ms and ends its own process. Never
// a kill by pid: once the agent has ended, Windows soon gives its pid to another process, which may
// be this very `relaylead` command. So a stop by id: run again on a session already ended, it only
// writes and removes its file (stopById below); given the object of a session from before its wake,
// it stops the woken one (currentPid).
async function stop(session) {
  const file = stopFile(session);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  withWindowsRetry(() => fs.writeFileSync(file, ''));
  // Ended already, or just now (watch-stop.js), killed, or without a process at all (its mission
  // folder gone, or a session made by a test): no agent will remove the file, so it is removed here.
  // A pid taken by another process only leaves the file behind.
  const gone = fs.existsSync(endedFile(session)) || fs.existsSync(killedFile(session)) || !isAlive(currentPid(session));
  if (gone) withWindowsRetry(() => fs.rmSync(file, { force: true }));
}

// Like Claude's wake: refuse a message claude would read as an option, stop the session, wait for its
// end (the ended file, the killed witness, or a dead pid: only a live pid can mislead, #62), then
// start its agent again under the same ids and files, with the message in its env. So wake-timeout
// only comes while the process may still run. The stop is read from module.exports, so a test can
// replace it.
async function wake(session, message) {
  if (String(message).startsWith('-')) throw codedError('bad-prompt', { what: 'message' });
  const pid = currentPid(session);
  await module.exports.stop(session);
  const deadline = Date.now() + wakeTimeoutMs();
  while (!fs.existsSync(endedFile(session)) && !fs.existsSync(killedFile(session)) && isAlive(pid)) {
    if (Date.now() >= deadline) throw codedError('wake-timeout', { shortId: session.shortId, seconds: wakeTimeoutMs() / 1000 });
    await sleep(50);
  }
  const files = sessionFiles(session);
  for (const file of Object.values(files)) withWindowsRetry(() => fs.rmSync(file, { force: true }));
  const env = {
    ...process.env,
    RELAYLEAD_TASK: undefined,
    ...session.env,
    RELAYLEAD_FAKE_LOG: session.logFile,
    RELAYLEAD_FAKE_WAKE_MESSAGE: message,
  };
  const newPid = await startAgent(session.role, session.cwd, env, { ...files, shortId: session.shortId });
  // Every field of the record is kept: the core records the session again with what this returns.
  return { ...session, pid: newPid, state: 'working', idle: false };
}

// Nothing to show: the call is logged so tests can check it happened.
async function attach(session) {
  const mission = session.name.split('/')[0];
  fs.appendFileSync(
    path.join(missionDir(mission), 'fake-attach.log'),
    `${new Date().toISOString()} attach ${session.shortId}\n`,
  );
  return 0;
}

// Like `claude rm`: the fake agent keeps no list of its own, so the call is logged in the mission
// folder (fake-forget.log) for the tests. A mission folder already removed is left alone.
async function forget(session) {
  const folder = missionDir(session.name.split('/')[0]);
  if (!fs.existsSync(folder)) return;
  fs.appendFileSync(path.join(folder, 'fake-forget.log'), `${new Date().toISOString()} forget ${session.shortId}\n`);
}

module.exports = {
  name: 'fake',
  capabilities: ['launch', 'list', 'stop', 'attach', 'wake', 'forget'],
  stopById: true,
  launch,
  list,
  stop,
  attach,
  wake,
  forget,
};
