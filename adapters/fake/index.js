// Fake adapter: each session is a small Node process (agent.js), so tests need no real agent.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { home, missionDir } = require('../../core/paths');
const { listSessions, isAlive } = require('../../core/sessions');
const { withWindowsRetry } = require('../../core/store');

const AGENT = path.join(__dirname, 'agent.js');

// The two files of a session's end (adapters/fake/watch-stop.js). The stop file asks the agent to
// end; it is outside the mission folder, which a failed launch removes while its lead may still run.
// The ended file says the agent has ended; it stays in
// the mission folder, and goes with it. Both paths are chosen at launch and kept in the session
// record (fields the core ignores), so a stop or a list made under another RELAYLEAD_HOME still finds
// them; a session recorded without them (by a test) gets the paths of the current home.
function stopFile(session) {
  return session.stopFile || path.join(home(), 'fake', `${session.shortId}.stop`);
}

function endedFile(session) {
  return session.endedFile || path.join(missionDir(session.name.split('/')[0]), `fake-${session.shortId}.ended`);
}

async function launch(spec) {
  const hex = crypto.randomBytes(8).toString('hex');
  const sessionId = 'fake-' + hex;
  const shortId = hex.slice(0, 8);
  // Where the agent writes its failures, so a test that times out can show them.
  const log = path.join(missionDir(spec.mission), `fake-${spec.role}-${shortId}.log`);
  const files = { stopFile: stopFile({ shortId }), endedFile: endedFile({ shortId, name: spec.name }) };
  const child = spawn(process.execPath, [AGENT, spec.role], {
    cwd: spec.cwd,
    // Like a real session, it gets no task from the process that launched it, only from spec.env.
    env: {
      ...process.env,
      RELAYLEAD_TASK: undefined,
      ...spec.env,
      RELAYLEAD_FAKE_LOG: log,
      RELAYLEAD_FAKE_STOP: files.stopFile,
      RELAYLEAD_FAKE_ENDED: files.endedFile,
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
  return {
    sessionId,
    shortId,
    name: spec.name,
    role: spec.role,
    state: 'working',
    pid: child.pid,
    cwd: spec.cwd,
    ...files,
  };
}

// A fake session works as long as its process lives. Once its agent has written its end, it is done
// without a process: its pid may by now belong to another process, which is not to be waited for.
async function list(mission) {
  return listSessions(mission).map((session) => {
    if (fs.existsSync(endedFile(session))) return { ...session, state: 'done', pid: null };
    return { ...session, state: isAlive(session.pid) ? 'working' : 'done' };
  });
}

// Asks the session to end; its agent sees the file within 50 ms and ends its own process. Never
// a kill by pid: once the agent has ended, Windows soon gives its pid to another process, which may
// be this very `relaylead` command.
async function stop(session) {
  const file = stopFile(session);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  withWindowsRetry(() => fs.writeFileSync(file, ''));
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

module.exports = {
  name: 'fake',
  capabilities: ['launch', 'list', 'stop', 'attach'],
  launch,
  list,
  stop,
  attach,
};
