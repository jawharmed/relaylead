// Fake adapter: each session is a small Node process (agent.js), so tests need no real agent.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { missionDir } = require('../../core/paths');
const { listSessions, isAlive } = require('../../core/sessions');

const AGENT = path.join(__dirname, 'agent.js');

async function launch(spec) {
  const hex = crypto.randomBytes(8).toString('hex');
  const sessionId = 'fake-' + hex;
  const child = spawn(process.execPath, [AGENT, spec.role], {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
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
    shortId: hex.slice(0, 8),
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

// Only a live process is killed: a dead one's pid may already belong to another process.
async function stop(session) {
  if (!isAlive(session.pid)) return;
  try {
    process.kill(session.pid);
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }
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
