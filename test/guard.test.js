const test = require('node:test');
const assert = require('node:assert');
const { checkToolUse, isAllowed, denyMessage } = require('../core/guard');
const { DEFAULTS } = require('../core/config');
const { tmpDir } = require('../fixtures/helpers');
const { git, gitRepo } = require('../fixtures/git');

const GUARD = DEFAULTS.guard;

// A repository whose current branch is `branch`.
function repoOn(branch) {
  const dir = gitRepo({ 'README.md': 'demo\n' });
  if (branch !== 'main') git(dir, 'checkout', '-q', '-b', branch);
  return dir;
}

function bash(command, cwd) {
  return checkToolUse({ tool_name: 'Bash', tool_input: { command }, cwd }, GUARD);
}

function assertDenied(result, reason) {
  assert.strictEqual(result.decision, 'deny');
  assert.strictEqual(result.reason, reason);
}

test('git push origin relaylead/x is allowed', () => {
  assert.deepStrictEqual(bash('git push origin relaylead/x', repoOn('main')), { decision: 'allow' });
  assert.deepStrictEqual(bash('git push -u origin relaylead/x', repoOn('main')), { decision: 'allow' });
});

test('git push origin main is refused', () => {
  assertDenied(bash('git push origin main', repoOn('relaylead/x')), 'push to protected branch main');
  assertDenied(bash('git push origin master', repoOn('relaylead/x')), 'push to protected branch master');
});

test('git push origin HEAD:main is refused', () => {
  const dir = repoOn('relaylead/x');
  assertDenied(bash('git push origin HEAD:main', dir), 'push to protected branch main');
  assertDenied(bash('git push origin relaylead/x:refs/heads/main', dir), 'push to protected branch main');
  assertDenied(bash('git push origin :main', dir), 'push to protected branch main');
  assert.deepStrictEqual(bash('git push origin HEAD:relaylead/x', dir), { decision: 'allow' });
});

test('git push HEAD is judged by the current branch', () => {
  assertDenied(bash('git push origin HEAD', repoOn('main')), 'push to protected branch main');
  assert.deepStrictEqual(bash('git push origin HEAD', repoOn('relaylead/x')), { decision: 'allow' });
});

test('cd x && git push origin main is refused', () => {
  assertDenied(bash('cd x && git push origin main', repoOn('relaylead/x')), 'push to protected branch main');
  assertDenied(bash('git status; git push origin main', repoOn('relaylead/x')), 'push to protected branch main');
  assertDenied(bash('echo ok |\ngit push origin main', repoOn('relaylead/x')), 'push to protected branch main');
  assertDenied(bash('sleep 1 & git push origin main', repoOn('relaylead/x')), 'push to protected branch main');
});

test('git push origin main inside a subshell is refused', () => {
  const dir = repoOn('relaylead/x');
  assertDenied(bash('echo $(git push origin main)', dir), 'push to protected branch main');
  assertDenied(bash('echo `git push origin main`', dir), 'push to protected branch main');
  assertDenied(bash('(cd x; git push origin main)', dir), 'push to protected branch main');
});

test('git -C dir push origin main is refused', () => {
  assertDenied(bash('git -C ../other push origin main', repoOn('relaylead/x')), 'push to protected branch main');
});

test('bare git push on main is refused', () => {
  const dir = repoOn('main');
  assertDenied(bash('git push', dir), 'push to protected branch main');
  assertDenied(bash('git push origin', dir), 'push to protected branch main');
});

test('bare git push on a crew branch is allowed', () => {
  assert.deepStrictEqual(bash('git push', repoOn('relaylead/x')), { decision: 'allow' });
});

test('bare git push outside a repository is allowed', () => {
  assert.deepStrictEqual(bash('git push', tmpDir('relaylead not a repo-')), { decision: 'allow' });
});

test('bare git push -C on main is refused', () => {
  const main = repoOn('main');
  assertDenied(bash(`git -C "${main}" push`, repoOn('relaylead/x')), 'push to protected branch main');
});

test('git push --all and --mirror are refused', () => {
  const dir = repoOn('relaylead/x');
  assertDenied(bash('git push --all origin', dir), 'push of every branch');
  assertDenied(bash('git push --mirror origin', dir), 'push of every branch');
});

test('git push -f is refused', () => {
  const dir = repoOn('relaylead/x');
  assertDenied(bash('git push -f', dir), 'force push');
  assertDenied(bash('git push --force origin relaylead/x', dir), 'force push');
  assertDenied(bash('git push --force-with-lease origin relaylead/x', dir), 'force push');
  assertDenied(bash('git push --force-with-lease=relaylead/x origin relaylead/x', dir), 'force push');
  assertDenied(bash('git push origin +relaylead/x', dir), 'force push');
  assertDenied(bash('git push -uf origin relaylead/x', dir), 'force push');
});

test('git commit on a protected branch is refused', () => {
  assertDenied(bash('git commit -m "wip"', repoOn('main')), 'commit on protected branch main');
  assertDenied(bash('git add -A && git commit -m wip', repoOn('main')), 'commit on protected branch main');
});

test('git commit on a crew branch is allowed', () => {
  assert.deepStrictEqual(bash('git commit -m "wip"', repoOn('relaylead/x')), { decision: 'allow' });
});

test('cat .env is refused', () => {
  const dir = tmpDir();
  assertDenied(bash('cat .env', dir), 'access to secret file .env');
  assertDenied(bash('cp config/.env.local /tmp/x', dir), 'access to secret file .env.local');
  assertDenied(bash('node --env-file=.env app.js', dir), 'access to secret file .env');
  assertDenied(bash("grep KEY '.env'", dir), 'access to secret file .env');
});

test('commands that only look like secrets are allowed', () => {
  const dir = tmpDir();
  assert.deepStrictEqual(bash('cat README.md config/app.env.md', dir), { decision: 'allow' });
  assert.deepStrictEqual(bash('echo .environment', dir), { decision: 'allow' });
});

test('a Read of .env is refused', () => {
  const read = (file_path) => checkToolUse({ tool_name: 'Read', tool_input: { file_path }, cwd: tmpDir() }, GUARD);
  assertDenied(read('/project/.env'), 'access to secret file .env');
  assertDenied(read('C:\\project\\.env'), 'access to secret file .env');
  assert.deepStrictEqual(read('/project/src/env.js'), { decision: 'allow' });
});

test('a Write or Edit of a secret is refused', () => {
  const use = (tool_name) =>
    checkToolUse({ tool_name, tool_input: { file_path: '/project/.env.production' }, cwd: tmpDir() }, GUARD);
  assertDenied(use('Write'), 'access to secret file .env.production');
  assertDenied(use('Edit'), 'access to secret file .env.production');
});

test('the mission guard decides the protected branches and the secrets', () => {
  const guard = { protectedBranches: ['release/*'], secrets: ['*.pem'], allow: [] };
  const check = (command) => checkToolUse({ tool_name: 'Bash', tool_input: { command }, cwd: tmpDir() }, guard);
  assertDenied(check('git push origin release/1.0'), 'push to protected branch release/1.0');
  assert.deepStrictEqual(check('git push origin main'), { decision: 'allow' });
  assertDenied(check('cat keys/server.pem'), 'access to secret file server.pem');
  assert.deepStrictEqual(check('cat .env'), { decision: 'allow' });
});

test('other tools are allowed', () => {
  const result = checkToolUse({ tool_name: 'Glob', tool_input: { pattern: '**/*.js' }, cwd: tmpDir() }, GUARD);
  assert.deepStrictEqual(result, { decision: 'allow' });
});

test('allow patterns match a tool name or a Bash command', () => {
  const patterns = ['Read', 'Bash(git *)', 'Bash(npm test*)'];
  const request = (tool_name, tool_input) => isAllowed({ tool_name, tool_input }, patterns);
  assert.strictEqual(request('Read', { file_path: '/project/a.js' }), true);
  assert.strictEqual(request('Bash', { command: 'git status' }), true);
  assert.strictEqual(request('Bash', { command: 'npm test -- --watch' }), true);
  assert.strictEqual(request('Bash', { command: 'git add -A && npm test' }), true);
  assert.strictEqual(request('Bash', { command: 'git status && rm -r src' }), false);
  assert.strictEqual(request('Bash', { command: 'npm install' }), false);
  assert.strictEqual(request('Bash', { command: 'npm test 2>&1' }), true);
  assert.strictEqual(request('Bash', { command: 'git commit -m "feat(guard): refuse pushes"' }), true);
  assert.strictEqual(request('Bash', { command: 'git status $(rm -r src)' }), false);
  assert.strictEqual(request('Bash', { command: 'git status `rm -r src`' }), false);
  assert.strictEqual(request('Write', { file_path: '/project/a.js' }), false);
  assert.strictEqual(isAllowed({ tool_name: 'Bash', tool_input: { command: 'rm -r src' } }, ['Bash']), true);
});

test('the refusal message says what to do next', () => {
  assert.strictEqual(
    denyMessage('force push'),
    'Blocked by Relaylead: force push. Continue with the rest of the task, one command per call.',
  );
});
