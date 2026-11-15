const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { getAdapter } = require('../adapters');
const { recordSession } = require('../core/sessions');
const { missionDir } = require('../core/paths');
const { tmpDir, waitFor } = require('../fixtures/helpers');

test('fake adapter launches, lists, attaches and stops a session', async (t) => {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  const fake = getAdapter('fake');
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
  assert.match(session.sessionId, /^fake-/);
  assert.strictEqual(session.shortId, session.sessionId.slice(0, 8));
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
  await waitFor(async () => (await fake.list('demo'))[0].state === 'done', 5000, 'the session to end');
});
