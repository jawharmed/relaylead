const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const claude = require('../adapters/claude');
const { apiKeyEnv, importApiKey } = require('../core/auth');
const { missionDir } = require('../core/paths');
const { writeJson } = require('../core/store');
const { tmpDir } = require('../fixtures/helpers');

const FAKE = path.join(__dirname, '..', 'fixtures', 'claude', 'fake-claude.js');
const SENTINEL = 'sk-test-SENTINEL';
const KEYS = ['RELAYLEAD_HOME', 'RELAYLEAD_CLAUDE', 'FAKE_CLAUDE_STATE', 'FAKE_CLAUDE_SCENARIO', 'ANTHROPIC_API_KEY'];
const PROFILE = { name: 'developer', model: 'sonnet', effort: 'low', tools: ['Read'], instructions: 'Be brief.' };

// A home, a mission and a fake claude; `auth` goes to the machine configuration.
function setup(t, auth) {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  const state = tmpDir('relaylead-fake-claude-');
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  process.env.RELAYLEAD_CLAUDE = FAKE;
  process.env.FAKE_CLAUDE_STATE = state;
  process.env.FAKE_CLAUDE_SCENARIO = 'normal';
  delete process.env.ANTHROPIC_API_KEY;
  const dir = fs.realpathSync.native(tmpDir('relaylead project '));
  writeJson(path.join(missionDir('demo'), 'mission.json'), { name: 'demo', dir, agent: 'claude', config: { attribution: null } });
  writeJson(path.join(process.env.RELAYLEAD_HOME, 'config.json'), { auth });
  t.after(() => {
    fs.writeFileSync(path.join(state, 'stop-all'), '');
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  return { dir, state, keyFile: path.join(process.env.RELAYLEAD_HOME, 'api-key') };
}

const launchSpec = (dir) => ({
  mission: 'demo', name: 'demo/developer/1', role: 'crew', profile: PROFILE, prompt: 'Go.', cwd: dir, env: {}, permissionMode: 'allowlist',
});

// The ANTHROPIC_API_KEY seen by each call of the fake claude, in order.
const keysSeen = (state) => fs.readFileSync(path.join(state, 'env.log'), 'utf8').trim().split('\n');

test('api-key mode: the key read from the file reaches the environment of the launch, and only there', async (t) => {
  const { dir, state, keyFile } = setup(t, { mode: 'api-key' });
  fs.writeFileSync(keyFile, SENTINEL + '\n');
  await claude.launch(launchSpec(dir));
  const calls = fs.readFileSync(path.join(state, 'calls.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const seen = keysSeen(state);
  assert.ok(calls.some((args) => args.includes('--bg')));
  calls.forEach((args, index) => assert.strictEqual(seen[index], args.includes('--bg') ? SENTINEL : '-'));
  // Not in the session's settings either.
  const settings = fs.readFileSync(path.join(missionDir('demo'), 'settings', 'demo-developer-1.json'), 'utf8');
  assert.ok(!settings.includes(SENTINEL));
});

test('login mode does not define ANTHROPIC_API_KEY', async (t) => {
  const { dir, state, keyFile } = setup(t, { mode: 'login' });
  fs.writeFileSync(keyFile, SENTINEL + '\n');
  await claude.launch(launchSpec(dir));
  assert.ok(keysSeen(state).every((value) => value === '-'));
});

test('api-key mode with a missing or empty file fails with api-key-missing, without any key in the error', async (t) => {
  const { dir, keyFile } = setup(t, { mode: 'api-key' });
  await assert.rejects(claude.launch(launchSpec(dir)), (err) => err.code === 'api-key-missing' && err.vars.file === keyFile);
  fs.writeFileSync(keyFile, '\n');
  assert.throws(() => apiKeyEnv({ auth: { mode: 'api-key' } }), { code: 'api-key-missing' });
});

test('importApiKey copies the variable into a file readable by its owner only', (t) => {
  const { keyFile } = setup(t, { mode: 'api-key' });
  importApiKey('MY_KEY', { MY_KEY: SENTINEL }, keyFile);
  assert.strictEqual(fs.readFileSync(keyFile, 'utf8').trim(), SENTINEL);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.throws(() => importApiKey('NOT_SET', {}, keyFile), { code: 'api-key-env-empty' });
});
