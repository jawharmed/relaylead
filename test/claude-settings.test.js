const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { sessionSettings, writeSessionSettings } = require('../adapters/claude/settings');
const { tmpDir } = require('../fixtures/helpers');

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
