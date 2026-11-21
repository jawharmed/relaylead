const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { installEnv, runRelaylead, outsideSnapshot } = require('../fixtures/install-env');
const { tmpDir } = require('../fixtures/helpers');
const { t: msg } = require('../core/messages');

const run = (env, ...args) => runRelaylead(args, { cwd: tmpDir('relaylead-cwd-'), env });

test('install then doctor: every line is ok; uninstall puts the outside back as it was', async (t) => {
  const env = installEnv(t);
  const before = outsideSnapshot(env);

  const installed = await run(env, 'install');
  assert.strictEqual(installed.code, 0, installed.err + installed.out);
  const doctor = await run(env, 'doctor');
  assert.strictEqual(doctor.code, 0, doctor.out);
  const lines = doctor.out.trim().split('\n');
  assert.ok(lines.length >= 6);
  for (const line of lines) assert.match(line, /^ok /, line);
  assert.ok(fs.existsSync(path.join(env.RELAYLEAD_HOME, 'install.json')));
  assert.notDeepStrictEqual(outsideSnapshot(env), before);

  const removed = await run(env, 'uninstall');
  assert.strictEqual(removed.code, 0, removed.err);
  assert.deepStrictEqual(outsideSnapshot(env), before);
  assert.ok(!fs.existsSync(path.join(env.RELAYLEAD_HOME, 'install.json')));
  assert.ok(fs.existsSync(env.RELAYLEAD_HOME), 'the home stays without --purge');
});

test('install twice leaves one plist; uninstall --purge deletes the home', async (t) => {
  const env = installEnv(t);
  await run(env, 'install');
  const second = await run(env, 'install');
  assert.strictEqual(second.code, 0, second.err);
  assert.deepStrictEqual(outsideSnapshot(env).agents, ['dev.relaylead.watcher.plist']);
  assert.deepStrictEqual(outsideSnapshot(env).plugins.plugins, ['relaylead@relaylead-local']);

  const purged = await run(env, 'uninstall', '--purge');
  assert.strictEqual(purged.code, 0, purged.err);
  assert.ok(!fs.existsSync(env.RELAYLEAD_HOME));
});

test('uninstall without install.json does not fail', async (t) => {
  const env = installEnv(t);
  const result = await run(env, 'uninstall');
  assert.strictEqual(result.code, 0, result.err);
  assert.match(result.out, /nothing to uninstall/);
});

test('without claude, install keeps the scheduler and skips the plugin', async (t) => {
  const env = installEnv(t, { RELAYLEAD_CLAUDE: path.join(tmpDir(), 'no-such-claude') });
  const result = await run(env, 'install');
  assert.match(result.out, /plugin skipped: claude not found/);
  assert.deepStrictEqual(outsideSnapshot(env).agents, ['dev.relaylead.watcher.plist']);
});

test('on another platform install and uninstall fail with platform-unsupported; doctor still runs', async (t) => {
  const env = installEnv(t, { RELAYLEAD_PLATFORM: 'linux' });
  const text = msg('platform-unsupported', { platform: 'linux' });
  for (const command of ['install', 'uninstall']) {
    const result = await run(env, command);
    assert.strictEqual(result.code, 1);
    assert.ok(result.err.includes(text), result.err);
  }
  const doctor = await run(env, 'doctor');
  assert.strictEqual(doctor.code, 0, doctor.out);
  assert.match(doctor.out, /warn scheduler: unsupported platform/);
});

test('a claude that is too old is a fail, and doctor exits 1', async (t) => {
  const env = installEnv(t, { FAKE_CLAUDE_SCENARIO: 'old-version' });
  const doctor = await run(env, 'doctor');
  assert.strictEqual(doctor.code, 1);
  assert.match(doctor.out, /^fail claude: /m);
});

test('doctor warns about STOP, and about a plugin list that fails', async (t) => {
  const env = installEnv(t, { FAKE_CLAUDE_SCENARIO: 'plugin-fail' });
  fs.writeFileSync(path.join(env.RELAYLEAD_HOME, 'STOP'), '');
  const doctor = await run(env, 'doctor');
  assert.match(doctor.out, /^warn STOP: /m);
  assert.match(doctor.out, /^warn plugin: /m);
});

test('doctor says whether the key file is there, never its value', async (t) => {
  const env = installEnv(t);
  fs.writeFileSync(path.join(env.RELAYLEAD_HOME, 'config.json'), JSON.stringify({ auth: { mode: 'api-key' } }));
  const missing = await run(env, 'doctor');
  assert.match(missing.out, /^fail api-key: missing$/m);
  assert.strictEqual(missing.code, 1);
  fs.writeFileSync(path.join(env.RELAYLEAD_HOME, 'api-key'), 'sk-test-SENTINEL\n');
  const found = await run(env, 'doctor');
  assert.match(found.out, /^ok api-key: file found$/m);
  assert.ok(!(found.out + found.err).includes('SENTINEL'));
});
