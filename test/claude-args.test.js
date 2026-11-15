const test = require('node:test');
const assert = require('node:assert');
const { buildLaunchArgs, compareVersion } = require('../adapters/claude/args');

const profile = {
  name: 'dev',
  tools: ['Read', 'Edit', 'Bash(git status:*)'],
  model: 'sonnet',
  effort: 'high',
  instructions: 'Be careful.',
};

function build(overrides) {
  return buildLaunchArgs({
    profile,
    name: 'm/crew/1',
    settingsFile: '/tmp/s.json',
    permissionMode: 'allowlist',
    prompt: 'Do the task',
    ...overrides,
  });
}

test('allowedTools comes before every other option', () => {
  const args = build();
  assert.deepStrictEqual(args.slice(0, 4), ['--allowedTools', 'Read', 'Edit', 'Bash(git status:*)']);
  assert.strictEqual(args[4], '--permission-mode');
  assert.strictEqual(args[5], 'acceptEdits');
  const all = build({ permissionMode: 'all' });
  assert.deepStrictEqual(all.slice(0, 7), ['--allowedTools', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']);
  assert.strictEqual(all[7], '--permission-mode');
});

test('prompt is the last argument', () => {
  const args = build();
  assert.strictEqual(args[args.length - 1], 'Do the task');
  assert.ok(args.includes('--bg'));
  assert.strictEqual(args[args.indexOf('--name') + 1], 'm/crew/1');
  assert.strictEqual(args[args.indexOf('--model') + 1], 'sonnet');
  assert.strictEqual(args[args.indexOf('--effort') + 1], 'high');
  assert.strictEqual(args[args.indexOf('--append-system-prompt') + 1], 'Be careful.');
  assert.strictEqual(args[args.indexOf('--settings') + 1], '/tmp/s.json');
  assert.strictEqual(args[args.indexOf('--setting-sources') + 1], 'project,local');
  assert.ok(args.includes('--strict-mcp-config'));
});

test('never passes --session-id or --agents, and skips what the profile leaves out', () => {
  const args = build({ profile: { name: 'bare', tools: [], model: null, effort: null, instructions: '' }, permissionMode: 'all' });
  assert.ok(!args.includes('--session-id'));
  assert.ok(!args.includes('--agents'));
  assert.ok(!args.includes('--model'));
  assert.ok(!args.includes('--effort'));
  assert.ok(!args.includes('--append-system-prompt'));
});

test('compareVersion reads the claude version text', () => {
  assert.strictEqual(compareVersion('2.1.330 (Claude Code)', '2.1.325'), true);
  assert.strictEqual(compareVersion('2.1.325 (Claude Code)', '2.1.325'), true);
  assert.strictEqual(compareVersion('2.1.9 (Claude Code)', '2.1.325'), false);
  assert.strictEqual(compareVersion('3.0.0', '2.1.325'), true);
  assert.strictEqual(compareVersion('nonsense', '2.1.325'), false);
});

test('a profile without tools is refused in allowlist mode', () => {
  assert.throws(() => build({ profile: { ...profile, tools: [] } }), { code: 'profile-without-tools' });
  assert.doesNotThrow(() => build({ profile: { ...profile, tools: [] }, permissionMode: 'all' }));
});
