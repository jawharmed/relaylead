const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { getAdapter } = require('../adapters');
const { recordSession, isAlive } = require('../core/sessions');
const { missionDir } = require('../core/paths');
const { tmpDir, waitFor } = require('../fixtures/helpers');

const fake = getAdapter('fake');

// A crew session of mission demo, in a fresh home, without a task: it runs until stopped.
async function launchSession(t) {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  const session = await fake.launch({
    mission: 'demo',
    name: 'demo/developer/1',
    role: 'crew',
    profile: null,
    prompt: '',
    cwd: tmpDir('relaylead-project-'),
    env: {},
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
  await waitFor(() => !isAlive(session.pid), 30000, 'the session process to end');
  assert.ok(isAlive(unrelated.pid));
});
