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

  const cache = path.join(env.CLAUDE_CONFIG_DIR, 'plugins', 'cache');
  fs.mkdirSync(path.join(cache, 'relaylead-local', 'relaylead'), { recursive: true });
  fs.mkdirSync(path.join(cache, 'other-market'), { recursive: true });
  const purged = await run(env, 'uninstall', '--purge');
  assert.strictEqual(purged.code, 0, purged.err);
  assert.ok(!fs.existsSync(env.RELAYLEAD_HOME));
  assert.deepStrictEqual(fs.readdirSync(cache), ['other-market'], 'only the plugin cache of relaylead-local goes');
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

test('doctor says whether the key file is there and claude picks it, never its value', async (t) => {
  const env = installEnv(t);
  fs.writeFileSync(path.join(env.RELAYLEAD_HOME, 'config.json'), JSON.stringify({ auth: { mode: 'api-key' } }));
  const missing = await run(env, 'doctor');
  assert.match(missing.out, /^fail api-key: missing$/m);
  assert.strictEqual(missing.code, 1);
  fs.writeFileSync(path.join(env.RELAYLEAD_HOME, 'api-key'), 'sk-test-SENTINEL\n');
  const found = await run(env, 'doctor');
  assert.match(found.out, /^ok api-key: file found$/m);
  assert.match(found.out, /^ok api-key-use: claude picks the key through apiKeyHelper$/m);
  assert.match(found.out, /^ok api-key-check: .*\/status must name apiKeyHelper/m);
  assert.ok(!(found.out + found.err).includes('SENTINEL'));
  // The fake claude, like Claude Code, ranks a key of the environment above the helper.
  const shadowed = await run({ ...env, ANTHROPIC_API_KEY: 'sk-test-SHELL' }, 'doctor');
  assert.match(shadowed.out, /^ok api-key-use: /m);
});

// The fake claude's plugins, read in its state folder.
const fakePlugins = (env) => JSON.parse(fs.readFileSync(path.join(env.FAKE_CLAUDE_STATE, 'plugins.json'), 'utf8'));

test('uninstall goes to the end when the plugin is already gone, or claude is not found', async (t) => {
  const env = installEnv(t);
  await run(env, 'install');
  // The user removed the plugin by hand.
  const file = path.join(env.FAKE_CLAUDE_STATE, 'plugins.json');
  fs.writeFileSync(file, JSON.stringify({ ...fakePlugins(env), plugins: [] }));
  const removed = await run(env, 'uninstall', '--purge');
  assert.strictEqual(removed.code, 0, removed.err + removed.out);
  assert.deepStrictEqual(outsideSnapshot(env), { agents: [], plugins: { marketplaces: [], plugins: [] } });
  assert.ok(!fs.existsSync(env.RELAYLEAD_HOME));

  // claude is gone: warnings with the command to run, and the rest is done.
  const lost = installEnv(t);
  await run(lost, 'install');
  lost.RELAYLEAD_CLAUDE = path.join(tmpDir(), 'no-such-claude');
  const result = await run(lost, 'uninstall', '--purge');
  assert.strictEqual(result.code, 0, result.err + result.out);
  assert.match(result.out, /warning: could not remove the plugin/);
  assert.deepStrictEqual(outsideSnapshot(lost).agents, []);
  assert.ok(!fs.existsSync(lost.RELAYLEAD_HOME));
});

test('uninstall without install.json still removes the plist', async (t) => {
  const env = installEnv(t);
  await run(env, 'install');
  fs.rmSync(path.join(env.RELAYLEAD_HOME, 'install.json'));
  const result = await run(env, 'uninstall');
  assert.strictEqual(result.code, 0, result.err);
  assert.deepStrictEqual(outsideSnapshot(env), { agents: [], plugins: { marketplaces: [], plugins: [] } });
});

test('a plugin install that fails halfway is noted, and uninstall removes the marketplace; install again is fine when it exists', async (t) => {
  const env = installEnv(t, { FAKE_CLAUDE_SCENARIO: 'plugin-install-fail' });
  const failed = await run(env, 'install');
  assert.strictEqual(failed.code, 1);
  const record = JSON.parse(fs.readFileSync(path.join(env.RELAYLEAD_HOME, 'install.json'), 'utf8'));
  assert.deepStrictEqual(record.plugin, { marketplace: 'relaylead-local' });
  assert.deepStrictEqual(fakePlugins(env).marketplaces, ['relaylead-local']);

  // The marketplace is there already (the fake refuses to add it twice): install goes on.
  env.FAKE_CLAUDE_SCENARIO = 'normal';
  const again = await run(env, 'install');
  assert.strictEqual(again.code, 0, again.err + again.out);
  assert.deepStrictEqual(fakePlugins(env), { marketplaces: ['relaylead-local'], plugins: ['relaylead@relaylead-local'] });

  // And a half install is undone by uninstall.
  await run(env, 'uninstall');
  env.FAKE_CLAUDE_SCENARIO = 'plugin-install-fail';
  await run(env, 'install');
  env.FAKE_CLAUDE_SCENARIO = 'normal';
  await run(env, 'uninstall');
  assert.deepStrictEqual(fakePlugins(env), { marketplaces: [], plugins: [] });
});

test('uninstall --purge refuses a folder that does not look like relaylead\'s, and deletes nothing', async (t) => {
  const env = installEnv(t);
  fs.writeFileSync(path.join(env.RELAYLEAD_HOME, 'notes.txt'), 'mine');
  const result = await run(env, 'uninstall', '--purge');
  assert.strictEqual(result.code, 1);
  assert.match(result.err, /does not look like a relaylead folder/);
  assert.ok(fs.existsSync(path.join(env.RELAYLEAD_HOME, 'notes.txt')));
});
