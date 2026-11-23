const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { installEnv, runRelaylead, outsideSnapshot } = require('../fixtures/install-env');
const { tmpDir } = require('../fixtures/helpers');
const { gitRepo } = require('../fixtures/git');
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

test('install updates a plugin left in an older version', async (t) => {
  const env = installEnv(t);
  await run(env, 'install');
  const file = path.join(env.FAKE_CLAUDE_STATE, 'plugins.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.versions = { 'relaylead@relaylead-local': '0.0.1' };
  fs.writeFileSync(file, JSON.stringify(state));
  const updated = await run(env, 'install');
  assert.strictEqual(updated.code, 0, updated.err);
  assert.ok(updated.out.includes(msg('plugin-updated', { id: 'relaylead@relaylead-local', from: '0.0.1', to: require('../package.json').version })), updated.out);
  assert.match(msg('plugin-updated', { id: 'x', from: 'a', to: 'b' }), /restart Claude Code/);
  const again = await run(env, 'install');
  assert.match(again.out, /plugin installed/);
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
  assert.deepStrictEqual(outsideSnapshot(env).plugins, { marketplaces: ['relaylead-local'], plugins: ['relaylead@relaylead-local'] });

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

test('uninstall --purge accepts a home that only init or launch created, and says its last line in the user\'s language', async (t) => {
  const env = installEnv(t);
  fs.writeFileSync(path.join(env.RELAYLEAD_HOME, 'config.json'), JSON.stringify({ language: 'fr' }));
  const result = await run(env, 'uninstall', '--purge');
  assert.strictEqual(result.code, 0, result.err + result.out);
  assert.strictEqual(result.out.trim().split('\n').pop(), `${env.RELAYLEAD_HOME} supprimé`);
  assert.ok(!fs.existsSync(env.RELAYLEAD_HOME));
  const missions = installEnv(t);
  fs.mkdirSync(path.join(missions.RELAYLEAD_HOME, 'missions'));
  assert.strictEqual((await run(missions, 'uninstall', '--purge')).code, 0);
});

// --- uninstall --purge and the missions not over (lot H1) ---------------------------------------

const { run: runCli } = require('../core/cli');
const { listSessions, isAlive, recordSession } = require('../core/sessions');
const { writeJson } = require('../core/store');
const fake = require('../adapters/fake');
const { makeIo, waitFor } = require('../fixtures/helpers');
const { freshHome, writeMission } = require('../fixtures/missions');

// The variables of installEnv set in this process for the rest of test `t`, around a fresh home.
function inProcessInstallEnv(t) {
  freshHome(t);
  const env = installEnv(t, { RELAYLEAD_HOME: process.env.RELAYLEAD_HOME });
  const previous = {};
  for (const key of ['RELAYLEAD_LAUNCHD_DIR', 'RELAYLEAD_LAUNCHCTL', 'FAKE_LAUNCHCTL_STATE', 'RELAYLEAD_CLAUDE', 'FAKE_CLAUDE_STATE', 'RELAYLEAD_PLATFORM', 'CLAUDE_CONFIG_DIR']) {
    previous[key] = process.env[key];
    process.env[key] = env[key];
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  // Marked as relaylead's, as install does.
  fs.writeFileSync(path.join(env.RELAYLEAD_HOME, '.relaylead-home'), '');
  return env;
}

async function cli(...args) {
  const io = makeIo();
  const code = await runCli(args, io);
  return { code, out: io.out.text, err: io.err.text };
}

// A session of the fake agent recorded in mission `name`, alive until stopped.
async function liveSession(name, dir) {
  const session = await fake.launch({
    mission: name,
    name: `${name}/developer/1`,
    role: 'crew',
    profile: null,
    prompt: '',
    cwd: dir,
    env: { RELAYLEAD_MISSION: name },
    permissionMode: 'allowlist',
  });
  recordSession(name, session);
  assert.ok(isAlive(session.pid));
  return session;
}

// The CLI in this process; `onLine(line)` sees each line of its output as it is written.
async function cliWatched(args, onLine) {
  const io = makeIo();
  const write = io.out.write.bind(io.out);
  io.out.write = (chunk) => {
    String(chunk).split('\n').filter(Boolean).forEach(onLine);
    write(chunk);
  };
  const code = await runCli(args, io);
  return { code, out: io.out.text, err: io.err.text };
}

test('uninstall --purge refuses while a mission runs, and --force stops its sessions before deleting', async (t) => {
  const env = inProcessInstallEnv(t);
  const dir = tmpDir('relaylead-project-');
  const launched = await cli('launch', '--agent', 'fake', '--name', 'demo', '--dir', dir);
  assert.strictEqual(launched.code, 0, launched.err);
  await waitFor(() => listSessions('demo').length === 1, 30000, 'the lead to be recorded');
  const [lead] = listSessions('demo');
  assert.ok(isAlive(lead.pid));

  const refused = await cli('uninstall', '--purge');
  assert.strictEqual(refused.code, 1);
  assert.ok(refused.err.includes(msg('purge-active-missions', { missions: 'demo', dir: env.RELAYLEAD_HOME })), refused.err);
  assert.ok(fs.existsSync(path.join(env.RELAYLEAD_HOME, 'missions', 'demo')), 'nothing is deleted');
  assert.ok(isAlive(lead.pid));

  // When the stop is reported, the lead is gone and the home is still there.
  let atStop = null;
  const forced = await cliWatched(['uninstall', '--purge', '--force'], (line) => {
    if (line === 'mission demo stopped') atStop = { alive: isAlive(lead.pid), home: fs.existsSync(env.RELAYLEAD_HOME) };
  });
  assert.strictEqual(forced.code, 0, forced.err + forced.out);
  assert.deepStrictEqual(atStop, { alive: false, home: true });
  assert.ok(!isAlive(lead.pid));
  assert.ok(!fs.existsSync(env.RELAYLEAD_HOME));
});

test('uninstall without --purge warns that a mission is still running, naming it', async (t) => {
  const env = inProcessInstallEnv(t);
  writeMission('demo', tmpDir('relaylead-project-'));
  writeJson(path.join(env.RELAYLEAD_HOME, 'missions', 'demo', 'state.json'), { state: 'working' });
  const result = await cli('uninstall');
  assert.strictEqual(result.code, 0, result.err);
  assert.ok(result.out.includes(msg('uninstall-active-missions', { missions: 'demo' })), result.out);
  assert.ok(fs.existsSync(env.RELAYLEAD_HOME));
});

test('uninstall --purge is not refused by a mission that is over', async (t) => {
  const env = inProcessInstallEnv(t);
  writeMission('old', tmpDir('relaylead-project-'));
  writeJson(path.join(env.RELAYLEAD_HOME, 'missions', 'old', 'state.json'), { state: 'done' });
  const purged = await cli('uninstall', '--purge');
  assert.strictEqual(purged.code, 0, purged.err + purged.out);
  assert.ok(!fs.existsSync(env.RELAYLEAD_HOME));
});

test('uninstall --purge counts a done mission whose merge conflict is being resolved', async (t) => {
  const env = inProcessInstallEnv(t);
  const dir = tmpDir('relaylead-project-');
  writeMission('demo', dir);
  writeJson(path.join(env.RELAYLEAD_HOME, 'missions', 'demo', 'state.json'), { state: 'done' });
  writeJson(path.join(env.RELAYLEAD_HOME, 'missions', 'demo', 'merge.json'), { state: 'resolving' });
  const crew = await liveSession('demo', dir);

  const refused = await cli('uninstall', '--purge');
  assert.strictEqual(refused.code, 1);
  assert.ok(refused.err.includes(msg('purge-active-missions', { missions: 'demo', dir: env.RELAYLEAD_HOME })), refused.err);

  const forced = await cli('uninstall', '--purge', '--force');
  assert.strictEqual(forced.code, 0, forced.err + forced.out);
  assert.ok(!isAlive(crew.pid));
  assert.ok(!fs.existsSync(env.RELAYLEAD_HOME));
});

test('uninstall --purge --force stops the sessions of an unreadable mission', async (t) => {
  const env = inProcessInstallEnv(t);
  const dir = tmpDir('relaylead-project-');
  writeMission('demo', dir);
  const crew = await liveSession('demo', dir);
  fs.writeFileSync(path.join(env.RELAYLEAD_HOME, 'missions', 'demo', 'state.json'), '{ half written');

  const refused = await cli('uninstall', '--purge');
  assert.strictEqual(refused.code, 1);
  assert.ok(refused.err.includes(msg('purge-active-missions', { missions: 'demo', dir: env.RELAYLEAD_HOME })), refused.err);

  const forced = await cli('uninstall', '--purge', '--force');
  assert.strictEqual(forced.code, 0, forced.err + forced.out);
  assert.ok(!isAlive(crew.pid));
  assert.ok(!fs.existsSync(env.RELAYLEAD_HOME));
});

test('uninstall --purge --force deletes nothing when a stop fails, and says which mission', async (t) => {
  const env = inProcessInstallEnv(t);
  const dir = tmpDir('relaylead-project-');
  writeMission('demo', dir);
  const crew = await liveSession('demo', dir);
  const realStop = fake.stop;
  fake.stop = async () => {
    throw new Error('stop refused for the test');
  };
  t.after(() => {
    fake.stop = realStop;
  });

  const forced = await cli('uninstall', '--purge', '--force');
  assert.strictEqual(forced.code, 1);
  assert.match(forced.err, /could not stop the sessions of: demo \(.*stop refused for the test.*\); nothing was deleted/);
  assert.ok(fs.existsSync(path.join(env.RELAYLEAD_HOME, 'missions', 'demo')));
  assert.ok(isAlive(crew.pid));
  fake.stop = realStop;
  await fake.stop(crew);
});

test('install and doctor put a home readable by others back in 700', { skip: process.platform === 'win32' }, async (t) => {
  const env = installEnv(t);
  const modeOf = (file) => fs.statSync(file).mode & 0o777;
  fs.chmodSync(env.RELAYLEAD_HOME, 0o755);
  const installed = await run(env, 'install');
  assert.strictEqual(installed.code, 0, installed.err + installed.out);
  assert.strictEqual(modeOf(env.RELAYLEAD_HOME), 0o700);
  assert.strictEqual(modeOf(path.join(env.RELAYLEAD_HOME, 'install.json')), 0o600);
  assert.match(installed.out, /^ok permissions: .* readable by you only$/m);

  fs.chmodSync(env.RELAYLEAD_HOME, 0o755);
  const doctor = await run(env, 'doctor');
  assert.ok(doctor.out.includes(`ok permissions: ${msg('doctor-home-fixed', { dir: env.RELAYLEAD_HOME, mode: '755' })}`), doctor.out);
  assert.strictEqual(modeOf(env.RELAYLEAD_HOME), 0o700);
});

test('doctor warns about unknown settings and values it cannot use, in both files', async (t) => {
  const env = installEnv(t);
  fs.writeFileSync(
    path.join(env.RELAYLEAD_HOME, 'config.json'),
    JSON.stringify({ language: 'de', parallel: 'many', permissionMode: 'yolo', maxSessions: 0, paralel: 2 }),
  );
  // As process.cwd() spells it in the CLI.
  const project = fs.realpathSync(tmpDir('relaylead-project-'));
  const projectFile = path.join(project, '.relaylead.json');
  fs.writeFileSync(projectFile, JSON.stringify({ team: 'code', delivery: { type: 'files' }, sorce: {} }));
  const doctor = await runRelaylead(['doctor'], { cwd: project, env });
  const machineFile = path.join(env.RELAYLEAD_HOME, 'config.json');
  const warnings = doctor.out.split('\n').filter((line) => line.startsWith('warn config: '));
  assert.deepStrictEqual(warnings, [
    `warn config: ${msg('doctor-config-unknown-key', { file: machineFile, key: 'paralel' })}`,
    `warn config: ${msg('doctor-config-language', { file: machineFile, value: '"de"' })}`,
    `warn config: ${msg('doctor-config-permission-mode', { file: machineFile, value: '"yolo"' })}`,
    `warn config: ${msg('doctor-config-whole-number', { file: machineFile, key: 'parallel', value: '"many"' })}`,
    `warn config: ${msg('doctor-config-whole-number', { file: machineFile, key: 'maxSessions', value: '0' })}`,
    `warn config: ${msg('doctor-config-unknown-key', { file: projectFile, key: 'sorce' })}`,
  ]);

  // A project file that is not JSON is a fail.
  fs.writeFileSync(projectFile, '{ not json');
  const broken = await runRelaylead(['doctor'], { cwd: project, env });
  assert.strictEqual(broken.code, 1);
  assert.match(broken.out, /^fail config: invalid JSON in .*\.relaylead\.json/m);
});

test('doctor warns when what the plist froze is gone', async (t) => {
  const env = installEnv(t);
  const installed = await run(env, 'install');
  assert.strictEqual(installed.code, 0, installed.err + installed.out);
  const plist = fs.readdirSync(env.RELAYLEAD_LAUNCHD_DIR).map((name) => path.join(env.RELAYLEAD_LAUNCHD_DIR, name))[0];
  // The Node of the plist was removed (an update by nvm).
  const gone = path.join(tmpDir(), 'v0.0.0', 'bin', 'node');
  fs.writeFileSync(plist, fs.readFileSync(plist, 'utf8').replace(`<string>${process.execPath}</string>`, `<string>${gone}</string>`));
  const doctor = await run(env, 'doctor');
  assert.ok(doctor.out.includes(`warn scheduler: ${msg('doctor-plist-missing', { file: gone })}`), doctor.out);
});

test('doctor warns when claude is not on the PATH the plist froze', { skip: process.platform === 'win32' }, async (t) => {
  // An empty PATH: no claude there, and the real claude is never run.
  const empty = tmpDir('relaylead-empty-path-');
  const env = installEnv(t, { PATH: empty });
  // Its doctor fails on git, not found on that PATH; the plist is written all the same.
  const installed = await run(env, 'install');
  assert.match(installed.out, /^scheduler installed /m, installed.err + installed.out);
  const doctor = await run(env, 'doctor');
  assert.ok(doctor.out.includes(`warn scheduler: ${msg('doctor-plist-no-claude', { path: empty })}`), doctor.out);
  // A claude in that folder is enough.
  fs.writeFileSync(path.join(empty, 'claude'), '');
  const found = await run(env, 'doctor');
  assert.ok(!found.out.includes('claude is not on the PATH'), found.out);
});

test('the settings init writes give no config warning in doctor', async (t) => {
  const env = installEnv(t);
  const project = fs.realpathSync(gitRepo({ 'README.md': 'demo\n' }));
  const init = await runRelaylead(['init', '--yes'], { cwd: project, env });
  assert.strictEqual(init.code, 0, init.err + init.out);
  assert.ok(fs.existsSync(path.join(project, '.relaylead.json')));
  const doctor = await runRelaylead(['doctor'], { cwd: project, env });
  assert.ok(!/^(warn|fail) config:/m.test(doctor.out), doctor.out);
});
