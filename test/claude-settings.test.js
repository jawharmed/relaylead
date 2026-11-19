const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { sessionSettings, writeSessionSettings } = require('../adapters/claude/settings');
const { tmpDir } = require('../fixtures/helpers');
const pkg = require('../package.json');

const PACKAGE_DIR = path.join(__dirname, '..');

// Runs the shim as the session's shell would: directly on POSIX, through cmd.exe on Windows (a .cmd
// cannot run without it; the quoting is the one Node uses for its own `shell` option).
function runShim(bin, args) {
  if (process.platform !== 'win32') return execFileSync(path.join(bin, 'relaylead'), args, { encoding: 'utf8' });
  const line = `"${path.join(bin, 'relaylead.cmd')}" ${args.join(' ')}`;
  return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
    encoding: 'utf8',
    windowsVerbatimArguments: true,
  });
}

const mission = { name: 'demo', config: { attribution: null } };
const profile = { name: 'dev', tools: ['Read', 'Edit'] };

function settingsFor(overrides) {
  process.env.RELAYLEAD_HOME = '/tmp/rl-home';
  return sessionSettings({ mission, packageDir: '/opt/relaylead', profile, permissionMode: 'allowlist', ...overrides });
}

test('hook commands quote paths with spaces', () => {
  const dir = path.join('C:', 'Program Files', 'relay lead');
  const settings = settingsFor({ packageDir: dir });
  const pretool = settings.hooks.PreToolUse[0].hooks[0];
  assert.strictEqual(pretool.type, 'command');
  assert.strictEqual(pretool.command, `"${process.execPath}" "${path.join(dir, 'core', 'hooks', 'pretool.js')}"`);
  const permission = settings.hooks.PermissionRequest[0].hooks[0];
  assert.strictEqual(permission.command, `"${process.execPath}" "${path.join(dir, 'core', 'hooks', 'permission.js')}"`);
});

test('hook commands keep a Windows path with backslashes and spaces', () => {
  const dir = 'C:\\Program Files\\relay lead';
  const command = settingsFor({ packageDir: dir }).hooks.PreToolUse[0].hooks[0].command;
  assert.ok(command.includes(`"${path.join(dir, 'core', 'hooks', 'pretool.js')}"`));
  assert.ok(command.startsWith(`"${process.execPath}" "`));
  assert.ok(command.includes('C:\\Program Files\\relay lead'));
  assert.strictEqual(JSON.parse(JSON.stringify({ command })).command, command);
});

test('settings carry mission, home and bash timeout', () => {
  const settings = settingsFor();
  assert.strictEqual(settings.env.RELAYLEAD_MISSION, 'demo');
  assert.strictEqual(settings.env.RELAYLEAD_HOME, '/tmp/rl-home');
  assert.strictEqual(settings.env.BASH_DEFAULT_TIMEOUT_MS, '600000');
  assert.deepStrictEqual(JSON.parse(settings.env.RELAYLEAD_ALLOW), ['Read', 'Edit']);
  assert.ok(!('attribution' in settings));
  const all = settingsFor({ permissionMode: 'all' });
  assert.deepStrictEqual(JSON.parse(all.env.RELAYLEAD_ALLOW), ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']);
  const attributed = settingsFor({ mission: { name: 'demo', config: { attribution: { commit: 'x' } } } });
  assert.deepStrictEqual(attributed.attribution, { commit: 'x' });
});

test('writeSessionSettings stores the file under the mission settings folder', () => {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  const file = writeSessionSettings({
    mission, packageDir: '/opt/relaylead', profile, permissionMode: 'allowlist', sessionName: 'demo/crew/2',
  });
  assert.strictEqual(file, path.join(process.env.RELAYLEAD_HOME, 'missions', 'demo', 'settings', 'demo-crew-2.json'));
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).env.RELAYLEAD_MISSION, 'demo');
});

test('the session environment is merged under the fixed keys', () => {
  const settings = settingsFor({ env: { RELAYLEAD_TASK: 'a', RELAYLEAD_MISSION: 'other', BASH_DEFAULT_TIMEOUT_MS: '1' } });
  assert.strictEqual(settings.env.RELAYLEAD_TASK, 'a');
  assert.strictEqual(settings.env.RELAYLEAD_MISSION, 'demo');
  assert.strictEqual(settings.env.BASH_DEFAULT_TIMEOUT_MS, '600000');
});

test('the session PATH starts with the mission bin folder, whose shim runs this relaylead', () => {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead home-'); // a space, like many Windows user folders
  const file = writeSessionSettings({
    mission, packageDir: PACKAGE_DIR, profile, permissionMode: 'allowlist', sessionName: 'demo/lead/1',
  });
  const bin = path.join(process.env.RELAYLEAD_HOME, 'missions', 'demo', 'bin');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).env.PATH, bin + path.delimiter + process.env.PATH);
  assert.strictEqual(runShim(bin, ['--version']).trim(), pkg.version);
});

test('the session environment passes the write retry budget on', (t) => {
  const saved = process.env.RELAYLEAD_WRITE_RETRY_MS;
  t.after(() => {
    if (saved === undefined) delete process.env.RELAYLEAD_WRITE_RETRY_MS;
    else process.env.RELAYLEAD_WRITE_RETRY_MS = saved;
  });
  process.env.RELAYLEAD_WRITE_RETRY_MS = '4000';
  assert.strictEqual(settingsFor().env.RELAYLEAD_WRITE_RETRY_MS, '4000');
  delete process.env.RELAYLEAD_WRITE_RETRY_MS;
  assert.ok(!('RELAYLEAD_WRITE_RETRY_MS' in settingsFor().env));
});

test('the session settings add the heartbeat hook and the measuring status line', () => {
  const dir = path.join('C:', 'Program Files', 'relay lead');
  const settings = settingsFor({ packageDir: dir });
  assert.deepStrictEqual(settings.hooks.PostToolUse, [
    { hooks: [{ type: 'command', command: `"${process.execPath}" "${path.join(dir, 'core', 'hooks', 'posttool.js')}"` }] },
  ]);
  assert.deepStrictEqual(settings.statusLine, {
    type: 'command',
    command: `"${process.execPath}" "${path.join(dir, 'core', 'hooks', 'statusline.js')}"`,
  });
});

test('the session settings add the Stop and StopFailure hooks', () => {
  const dir = path.join('C:', 'Program Files', 'relay lead');
  const settings = settingsFor({ packageDir: dir });
  const entry = (script) => [
    { hooks: [{ type: 'command', command: `"${process.execPath}" "${path.join(dir, 'core', 'hooks', `${script}.js`)}"` }] },
  ];
  assert.deepStrictEqual(settings.hooks.Stop, entry('stop'));
  assert.deepStrictEqual(settings.hooks.StopFailure, entry('stopfailure'));
});
