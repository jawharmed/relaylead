const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { installEnv, runRelaylead } = require('../fixtures/install-env');
const { gitRepo } = require('../fixtures/git');
const { tmpDir } = require('../fixtures/helpers');

const SENTINEL = 'sk-test-SENTINEL';
const read = (file) => fs.readFileSync(file, 'utf8');

test('init --yes in a repository writes the machine and the project files, and a second run changes nothing', async (t) => {
  const env = installEnv(t);
  const repo = gitRepo({ 'README.md': 'toy\n' });
  const machine = path.join(env.RELAYLEAD_HOME, 'config.json');
  const project = path.join(repo, '.relaylead.json');

  const first = await runRelaylead(['init', '--yes'], { cwd: repo, env });
  assert.strictEqual(first.code, 0, first.err);
  assert.deepStrictEqual(JSON.parse(read(machine)), {
    agent: 'claude',
    permissionMode: 'allowlist',
    auth: { mode: 'login', keyFile: null },
  });
  const config = JSON.parse(read(project));
  assert.strictEqual(config.team, 'code');
  assert.ok(config.method && config.source && config.delivery);
  assert.ok(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'catalog', 'teams', 'code.json'), 'utf8')).profiles.includes('lead'));

  const [machineText, projectText] = [read(machine), read(project)];
  const second = await runRelaylead(['init', '--yes'], { cwd: repo, env });
  assert.strictEqual(second.code, 0, second.err);
  assert.match(second.out, /kept as they are/);
  assert.strictEqual(read(machine), machineText);
  assert.strictEqual(read(project), projectText);
});

test('init imports the key of an environment variable into a 0600 file, and prints no key', async (t) => {
  const env = installEnv(t, { MY_TEST_KEY: SENTINEL });
  const repo = gitRepo({ 'README.md': 'toy\n' });
  const result = await runRelaylead(['init', '--yes', '--api-key-env', 'MY_TEST_KEY'], { cwd: repo, env });
  assert.strictEqual(result.code, 0, result.err);
  const keyFile = path.join(env.RELAYLEAD_HOME, 'api-key');
  assert.strictEqual(read(keyFile).trim(), SENTINEL);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.deepStrictEqual(JSON.parse(read(path.join(env.RELAYLEAD_HOME, 'config.json'))).auth, { mode: 'api-key', keyFile: null });
  assert.ok(!(result.out + result.err).includes(SENTINEL));
  assert.ok(!read(path.join(env.RELAYLEAD_HOME, 'config.json')).includes(SENTINEL));
});

test('init --api-key-file records the path as given', async (t) => {
  const env = installEnv(t);
  const repo = gitRepo({ 'README.md': 'toy\n' });
  const keyFile = path.join(tmpDir(), 'my-key');
  const result = await runRelaylead(['init', '--yes', '--api-key-file', keyFile], { cwd: repo, env });
  assert.strictEqual(result.code, 0, result.err);
  assert.deepStrictEqual(JSON.parse(read(path.join(env.RELAYLEAD_HOME, 'config.json'))).auth, { mode: 'api-key', keyFile });
});

test('outside a git repository init fails with not-a-git-repo', async (t) => {
  const env = installEnv(t);
  const result = await runRelaylead(['init', '--yes'], { cwd: tmpDir('relaylead-plain-'), env });
  assert.strictEqual(result.code, 1);
  assert.match(result.err, /not the root of a git repository/);
});

test('an existing config.json keeps its unknown keys', async (t) => {
  const env = installEnv(t);
  const repo = gitRepo({ 'README.md': 'toy\n' });
  fs.mkdirSync(env.RELAYLEAD_HOME, { recursive: true });
  const machine = path.join(env.RELAYLEAD_HOME, 'config.json');
  fs.writeFileSync(machine, JSON.stringify({ somethingElse: { a: 1 }, parallel: 2 }));
  await runRelaylead(['init', '--yes', '--api-key-file', '/somewhere/key'], { cwd: repo, env });
  const config = JSON.parse(read(machine));
  assert.deepStrictEqual(config.somethingElse, { a: 1 });
  assert.strictEqual(config.parallel, 2);
  assert.strictEqual(config.auth.mode, 'api-key');
});

test('without claude, init stops with agent-missing', async (t) => {
  const env = installEnv(t, { RELAYLEAD_CLAUDE: path.join(tmpDir(), 'no-such-claude') });
  const result = await runRelaylead(['init', '--yes'], { cwd: gitRepo({ 'a.txt': 'a\n' }), env });
  assert.strictEqual(result.code, 1);
  assert.match(result.err, /was not found/);
});
