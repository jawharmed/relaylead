// The hooks run as real processes, the way Claude Code runs them: JSON on stdin, decision on stdout.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { writeJson } = require('../core/store');
const { DEFAULTS } = require('../core/config');
const { tmpDir } = require('../fixtures/helpers');
const { gitRepo } = require('../fixtures/git');

const PRETOOL = path.join(__dirname, '..', 'core', 'hooks', 'pretool.js');
const PERMISSION = path.join(__dirname, '..', 'core', 'hooks', 'permission.js');

// A fresh RELAYLEAD_HOME whose path contains a space, with mission demo and the given guard.
function missionHome(guard) {
  const home = tmpDir('relaylead home-');
  writeJson(path.join(home, 'missions', 'demo', 'mission.json'), {
    name: 'demo',
    config: { ...structuredClone(DEFAULTS), guard: { ...DEFAULTS.guard, ...guard } },
  });
  return home;
}

function runHook(hook, input, env) {
  const childEnv = { ...process.env, ...env };
  if (!env.RELAYLEAD_MISSION) delete childEnv.RELAYLEAD_MISSION;
  if (!env.RELAYLEAD_ALLOW) delete childEnv.RELAYLEAD_ALLOW;
  const result = spawnSync(process.execPath, [hook], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: childEnv,
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout;
}

function journal(home) {
  const file = path.join(home, 'missions', 'demo', 'journal.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

test('pretool hook prints a deny decision', () => {
  const home = missionHome({ secrets: ['secret.txt'] });
  const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo' };
  const cwd = gitRepo({ 'README.md': 'demo\n' });

  const out = runHook(PRETOOL, { tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd }, env);
  assert.deepStrictEqual(JSON.parse(out), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'Blocked by Relaylead: push to protected branch main. Continue with the rest of the task, one command per call.',
    },
  });
  // The mission guard is used: its own secret list replaces the default one.
  const secret = runHook(PRETOOL, { tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'secret.txt') }, cwd }, env);
  assert.strictEqual(JSON.parse(secret).hookSpecificOutput.permissionDecision, 'deny');

  const lines = journal(home).trim().split('\n');
  assert.strictEqual(lines.length, 2);
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT\S+Z Bash push to protected branch main$/);
  assert.match(lines[1], /^\S+ Read access to secret file secret\.txt$/);
});

test('pretool hook prints nothing for an allowed action', () => {
  const home = missionHome({});
  const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo' };
  const out = runHook(PRETOOL, { tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: tmpDir() }, env);
  assert.strictEqual(out, '');
  assert.strictEqual(journal(home), '');
});

test('pretool hook uses the default guard without a mission', () => {
  const home = tmpDir('relaylead home-');
  const input = { tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd: tmpDir() };
  for (const env of [{ RELAYLEAD_HOME: home }, { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'unknown' }]) {
    assert.strictEqual(JSON.parse(runHook(PRETOOL, input, env)).hookSpecificOutput.permissionDecision, 'deny');
  }
  assert.strictEqual(fs.existsSync(path.join(home, 'missions')), false);
});

test('pretool hook ignores unreadable input and notes it in the journal', () => {
  const home = missionHome({});
  const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo' };
  assert.strictEqual(runHook(PRETOOL, 'not json', env), '');
  assert.strictEqual(runHook(PRETOOL, '[1]', env), '');
  assert.match(journal(home), /^\S+ unknown unreadable hook input\n\S+ unknown unreadable hook input\n$/);
});

test('pretool hook refuses when the guard fails', () => {
  // Wrong shapes fall back to the defaults: protected pushes and secrets are still refused.
  const home = missionHome({ protectedBranches: 'main', secrets: [1], allow: null });
  const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo' };
  const decide = (input) => JSON.parse(runHook(PRETOOL, input, env)).hookSpecificOutput.permissionDecisionReason;
  const cwd = tmpDir();
  assert.match(decide({ tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd }), /push to protected branch main/);
  assert.match(decide({ tool_name: 'Bash', tool_input: { command: 'cat .env' }, cwd }), /access to secret file \.env/);
  // An input the guard cannot judge is refused, not let through.
  assert.match(decide({ tool_name: 'Bash', tool_input: { command: 'cat a.txt' }, cwd: 42 }), /^Blocked by Relaylead: guard error\./);
  assert.match(journal(home), /\S+ Bash guard error\n$/);
});

test('pretool hook refuses the mission state folder', () => {
  const home = missionHome({});
  const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo' };
  const file = path.join(home, 'missions', 'demo', 'mission.json');
  const out = runHook(PRETOOL, { tool_name: 'Write', tool_input: { file_path: file, content: '{}' }, cwd: tmpDir() }, env);
  assert.match(JSON.parse(out).hookSpecificOutput.permissionDecisionReason, /access to the mission state folder/);
});

test('permission hook allows a listed command and denies the rest', () => {
  const home = missionHome({ allow: ['Bash(git status*)'] });
  const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo', RELAYLEAD_ALLOW: JSON.stringify(['Read', 'Bash(npm test*)']) };
  const cwd = tmpDir();
  const decide = (tool_name, tool_input) =>
    JSON.parse(runHook(PERMISSION, { hook_event_name: 'PermissionRequest', tool_name, tool_input, cwd }, env));
  const allow = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };

  assert.deepStrictEqual(decide('Bash', { command: 'git status --short' }), allow);
  assert.deepStrictEqual(decide('Bash', { command: 'npm test' }), allow);
  assert.deepStrictEqual(decide('Read', { file_path: path.join(cwd, 'a.js') }), allow);
  assert.deepStrictEqual(decide('Bash', { command: 'git status && rm -r src' }), {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'deny',
        message:
          'Blocked by Relaylead: Bash command not in the allowed tools. Continue with the rest of the task, one command per call.',
      },
    },
  });
  assert.strictEqual(decide('Write', { file_path: path.join(cwd, 'a.js') }).hookSpecificOutput.decision.behavior, 'deny');

  const lines = journal(home).trim().split('\n');
  assert.deepStrictEqual(
    lines.map((line) => line.split(' ').slice(1).join(' ')),
    ['Bash Bash command not in the allowed tools', 'Write Write not in the allowed tools'],
  );
  // No question is created: the permission question belongs to lot 3.
  assert.strictEqual(fs.existsSync(path.join(home, 'missions', 'demo', 'questions')), false);
});

test('permission hook answers even with a wrong-shaped guard', () => {
  const home = missionHome({ allow: [null] });
  const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo', RELAYLEAD_ALLOW: '[1]' };
  const decide = (input) => JSON.parse(runHook(PERMISSION, input, env)).hookSpecificOutput.decision.behavior;
  assert.strictEqual(decide({ tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: tmpDir() }), 'deny');
  assert.strictEqual(decide({ tool_input: {} }), 'deny');
  assert.strictEqual(decide([1]), 'deny');
  const tools = journal(home).trim().split('\n').map((line) => line.split(' ')[1]);
  assert.deepStrictEqual(tools, ['Bash', 'unknown', 'unknown']);
});
