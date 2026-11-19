const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { getAdapter } = require('../adapters');
const { recordSession, isAlive } = require('../core/sessions');
const { missionDir } = require('../core/paths');
const { tmpDir, waitFor, sessionEnded, killSession } = require('../fixtures/helpers');

const fake = getAdapter('fake');

// A session of mission demo (a crew member by default), in a fresh home. Without a task in `env`, it
// runs until stopped.
async function launchSession(t, env = {}, role = 'crew') {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  // Made by the core before any launch: the agent writes its files there.
  fs.mkdirSync(missionDir('demo'), { recursive: true });
  const session = await fake.launch({
    mission: 'demo',
    name: role === 'lead' ? 'demo/lead' : 'demo/developer/1',
    role,
    profile: null,
    prompt: '',
    cwd: tmpDir('relaylead-project-'),
    env,
    permissionMode: 'allowlist',
  });
  t.after(() => fake.stop(session));
  return session;
}

test('fake adapter launches, lists, attaches and stops a session', async (t) => {
  const session = await launchSession(t);
  assert.match(session.sessionId, /^fake-[0-9a-f]{16}$/);
  assert.strictEqual(session.shortId, session.sessionId.slice(5, 13));
  recordSession('demo', session);

  const listed = await fake.list('demo');
  assert.deepStrictEqual(
    listed.map((s) => [s.name, s.state]),
    [['demo/developer/1', 'working']],
  );

  assert.strictEqual(await fake.attach(session), 0);
  const log = fs.readFileSync(path.join(missionDir('demo'), 'fake-attach.log'), 'utf8');
  assert.ok(log.includes(session.shortId));

  await fake.stop(session);
  await waitFor(async () => (await fake.list('demo'))[0].state === 'done', 30000, 'the session to end');
});

test('fake stop ends the session process and kills nothing by its pid', async (t) => {
  const session = await launchSession(t);
  recordSession('demo', session);
  // The recorded pid now names an unrelated live process, as when Windows has given it to another one.
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => unrelated.kill());

  await fake.stop({ ...session, pid: unrelated.pid });
  await waitFor(() => sessionEnded(session), 30000, 'the session process to end');
  // A child of this test that has not ended: its pid is still its own.
  assert.ok(isAlive(unrelated.pid));
  // Removed by the agent as it ended, just after its ended file: the stop above saw the unrelated
  // process alive and left the file.
  await waitFor(() => !fs.existsSync(session.stopFile), 5000, 'the agent to remove its stop file');
});

test('an ended session is listed done without a pid, even when its pid now names another process', async (t) => {
  // With a task but no mission.json, the crew member fails after its second of work, and ends.
  const session = await launchSession(t, { RELAYLEAD_TASK: 'a' });
  recordSession('demo', session);
  await waitFor(() => sessionEnded(session), 30000, 'the session process to end');
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => unrelated.kill());
  recordSession('demo', { ...session, pid: unrelated.pid });

  assert.deepStrictEqual((await fake.list('demo')).map((s) => [s.state, s.pid]), [['done', null]]);
  // A stop after the end leaves no stop file behind.
  await fake.stop(session);
  assert.strictEqual(fs.existsSync(session.stopFile), false);
});

test('fake stop reaches the session from another RELAYLEAD_HOME', async (t) => {
  const session = await launchSession(t);
  recordSession('demo', session);
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');

  await fake.stop(session);
  await waitFor(() => sessionEnded(session), 30000, 'the session process to end');
});

test('the fake adapter stops by id, harmlessly on a session already ended', async (t) => {
  assert.strictEqual(fake.stopById, true);
  const session = await launchSession(t);
  recordSession('demo', session);

  await fake.stop(session);
  await waitFor(() => sessionEnded(session), 30000, 'the session process to end');
  await fake.stop(session);

  assert.strictEqual(fs.existsSync(session.stopFile), false);
});

// A lead that ends its first turn at once, recorded like the core does.
async function launchIdleLead(t) {
  const session = await launchSession(t, { RELAYLEAD_FAKE_END_FIRST_TURN: '1' }, 'lead');
  recordSession('demo', session);
  return session;
}

// The agent's log, empty until the agent has written to it.
function logText(session) {
  return fs.existsSync(session.logFile) ? fs.readFileSync(session.logFile, 'utf8') : '';
}

async function listed(session) {
  return (await fake.list('demo')).find((row) => row.shortId === session.shortId);
}

test('a fake session that ended its turn is listed waiting and idle', async (t) => {
  const session = await launchIdleLead(t);
  await waitFor(() => fs.existsSync(session.idleFile), 30000, 'the session to end its turn');

  const row = await listed(session);
  assert.deepStrictEqual([row.role, row.state, row.idle, row.pid], ['lead', 'waiting', true, session.pid]);
});

test('wake restarts a fake session under the same ids, with the message', async (t) => {
  const session = await launchIdleLead(t);
  await waitFor(() => fs.existsSync(session.idleFile), 30000, 'the session to end its turn');

  const woken = await fake.wake(session, 'hello');
  // Stopped with its own pid: stopped with the old one, dead, the stop would take it as gone.
  t.after(() => fake.stop(woken));
  recordSession('demo', woken);

  assert.strictEqual(woken.shortId, session.shortId);
  assert.strictEqual(woken.sessionId, session.sessionId);
  assert.notStrictEqual(woken.pid, session.pid);
  for (const field of ['idleFile', 'killedFile', 'logFile', 'env']) assert.deepStrictEqual(woken[field], session[field], field);
  await waitFor(() => logText(session).includes('woken: hello'), 30000, 'the message in the log');
  await waitFor(async () => (await listed(session)).state === 'waiting', 30000, 'the woken session to end its turn');
});

test('a killed fake session is listed failed without a process', async (t) => {
  const session = await launchSession(t);
  recordSession('demo', session);
  killSession(session);
  // Recorded by the test with a pid that cannot exist, and no witness.
  const dead = { ...session, sessionId: 'fake-00000000deadbeef', shortId: '00000000', pid: 2147483646 };
  delete dead.killedFile;
  delete dead.endedFile;
  delete dead.idleFile;
  recordSession('demo', dead);

  for (const one of [session, dead]) {
    const row = await listed(one);
    assert.deepStrictEqual([row.state, row.pid], ['failed', null], one.shortId);
  }
});

test('wake resumes a killed fake session', async (t) => {
  const session = await launchSession(t);
  recordSession('demo', session);
  killSession(session);

  const woken = await fake.wake(session, 'hello');
  // Stopped with its own pid: stopped with the old one, dead, the stop would take it as gone.
  t.after(() => fake.stop(woken));
  recordSession('demo', woken);

  assert.strictEqual(woken.shortId, session.shortId);
  assert.strictEqual(fs.existsSync(session.killedFile), false);
  const row = await listed(session);
  assert.deepStrictEqual([row.state, row.pid], ['working', woken.pid]);
  await waitFor(() => logText(session).includes('woken: hello'), 30000, 'the message in the log');
});

test('wake gives up when the fake session does not end', async (t) => {
  const session = await launchIdleLead(t);
  await waitFor(() => fs.existsSync(session.idleFile), 30000, 'the session to end its turn');
  const stop = fake.stop;
  fake.stop = async () => {};
  process.env.RELAYLEAD_FAKE_WAKE_MS = '300';
  try {
    await assert.rejects(fake.wake(session, 'hello'), { code: 'wake-timeout' });
  } finally {
    fake.stop = stop;
    delete process.env.RELAYLEAD_FAKE_WAKE_MS;
  }
  // Still the old process, judged on its own files, not on its pid.
  assert.strictEqual(sessionEnded(session), false);
  assert.deepStrictEqual([(await listed(session)).state, fake.capabilities.includes('wake')], ['waiting', true]);
});
