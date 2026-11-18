// Fake adapter: each session is a small Node process (agent.js), so tests need no real agent.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { home, missionDir } = require('../../core/paths');
const { listSessions, isAlive } = require('../../core/sessions');

const AGENT = path.join(__dirname, 'agent.js');

// The file that asks a session to end: its agent watches it and ends its own process. Outside the
// mission folder, which a failed launch removes while its lead may still run.
function stopFile(shortId) {
  return path.join(home(), 'fake', `${shortId}.stop`);
}

async function launch(spec) {
  const hex = crypto.randomBytes(8).toString('hex');
  const sessionId = 'fake-' + hex;
  const shortId = hex.slice(0, 8);
  // Where the agent writes its failures, so a test that times out can show them.
  const log = path.join(missionDir(spec.mission), `fake-${spec.role}-${shortId}.log`);
  const child = spawn(process.execPath, [AGENT, spec.role], {
    cwd: spec.cwd,
    // Like a real session, it gets no task from the process that launched it, only from spec.env.
    env: {
      ...process.env,
      RELAYLEAD_TASK: undefined,
      ...spec.env,
      RELAYLEAD_FAKE_LOG: log,
      RELAYLEAD_FAKE_STOP: stopFile(shortId),
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
  };
}

// A fake session works as long as its process lives.
async function list(mission) {
  return listSessions(mission).map((session) => ({
    ...session,
    state: isAlive(session.pid) ? 'working' : 'done',
  }));
}

// Asks the session to end; its agent sees the file within 50 ms and ends its own process. Never
// a kill by pid: once the agent has ended, Windows soon gives its pid to another process, which may
// be this very `relaylead` command. A session that has already ended just leaves the file behind.
async function stop(session) {
  const file = stopFile(session.shortId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
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
