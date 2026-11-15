const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { checkToolUse, isAllowed, denyMessage } = require('../core/guard');
const { DEFAULTS } = require('../core/config');
const { tmpDir } = require('../fixtures/helpers');
const { git, gitRepo } = require('../fixtures/git');

const GUARD = DEFAULTS.guard;
// File names that differ only by case are the same file on macOS and Windows.
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

// A repository whose current branch is `branch`.
function repoOn(branch) {
  const dir = gitRepo({ 'README.md': 'demo\n' });
  if (branch !== 'main') git(dir, 'checkout', '-q', '-b', branch);
  return dir;
}

function bash(command, cwd, guard = GUARD) {
  return checkToolUse({ tool_name: 'Bash', tool_input: { command }, cwd }, guard);
}

function assertDenied(result, reason) {
  assert.strictEqual(result.decision, 'deny');
  assert.strictEqual(result.reason, reason);
}

const ALLOW = { decision: 'allow' };

test('git push origin relaylead/x is allowed', () => {
  assert.deepStrictEqual(bash('git push origin relaylead/x', repoOn('main')), ALLOW);
  assert.deepStrictEqual(bash('git push -u origin relaylead/x', repoOn('main')), ALLOW);
  assert.deepStrictEqual(bash('git push origin relaylead/x >/dev/null 2>&1', repoOn('main')), ALLOW);
  assert.deepStrictEqual(bash('git push --follow-tags origin relaylead/x --force-if-includes', repoOn('main')), ALLOW);
});

test('git push origin main is refused', () => {
  assertDenied(bash('git push origin main', repoOn('relaylead/x')), 'push to protected branch main');
  assertDenied(bash('git push origin master', repoOn('relaylead/x')), 'push to protected branch master');
  assertDenied(bash('git push origin heads/main', repoOn('relaylead/x')), 'push to protected branch main');
  assertDenied(bash('git push origin main>/dev/null', repoOn('relaylead/x')), 'push to protected branch main');
});

test('git push origin HEAD:main is refused', () => {
  const dir = repoOn('relaylead/x');
  assertDenied(bash('git push origin HEAD:main', dir), 'push to protected branch main');
  assertDenied(bash('git push origin relaylead/x:refs/heads/main', dir), 'push to protected branch main');
  assertDenied(bash('git push origin :main', dir), 'push to protected branch main');
  assert.deepStrictEqual(bash('git push origin HEAD:relaylead/x', dir), ALLOW);
});

test('git push HEAD or @ is judged by the current branch', () => {
  assertDenied(bash('git push origin HEAD', repoOn('main')), 'push to protected branch main');
  assertDenied(bash('git push origin @', repoOn('main')), 'push to protected branch main');
  assert.deepStrictEqual(bash('git push origin HEAD', repoOn('relaylead/x')), ALLOW);
  assert.deepStrictEqual(bash('git push origin @', repoOn('relaylead/x')), ALLOW);
});

test('a computed branch name is refused', () => {
  const dir = repoOn('relaylead/x');
  const reason = 'push to a branch that cannot be judged';
  assertDenied(bash('git push origin "$(git branch --show-current)"', dir), reason);
  assertDenied(bash('git push -u origin $(git rev-parse --abbrev-ref HEAD)', dir), reason);
  assertDenied(bash('git push origin $BRANCH', dir), reason);
  assertDenied(bash('git push origin `git branch --show-current`', dir), reason);
});

test('the value of a push option is not taken for the remote', () => {
  assertDenied(bash('git push -o ci.skip origin', repoOn('main')), 'push to protected branch main');
  assertDenied(bash('git push --repo origin', repoOn('main')), 'push to protected branch main');
  assert.deepStrictEqual(bash('git push -o ci.skip origin', repoOn('relaylead/x')), ALLOW);
});

test('cd x && git push origin main is refused', () => {
  const dir = repoOn('relaylead/x');
  assertDenied(bash('cd x && git push origin main', dir), 'push to protected branch main');
  assertDenied(bash('git status; git push origin main', dir), 'push to protected branch main');
  assertDenied(bash('echo ok |\ngit push origin main', dir), 'push to protected branch main');
  assertDenied(bash('sleep 1 & git push origin main', dir), 'push to protected branch main');
});

test('git push anywhere in a piece is judged', () => {
  const dir = repoOn('relaylead/x');
  for (const command of [
    'timeout 60 git push origin main',
    'if true; then git push origin main; fi',
    '{ git push origin main; }',
    '! git push origin main',
    'time git push origin main',
    'GIT_TRACE=1 git push origin main',
    'GIT push origin main',
    '/usr/bin/git push origin main',
    'git --no-pager -c color.ui=never push origin main',
  ]) {
    assertDenied(bash(command, dir), 'push to protected branch main');
  }
});

test('git push origin main inside a subshell is refused', () => {
  const dir = repoOn('relaylead/x');
  assertDenied(bash('echo $(git push origin main)', dir), 'push to protected branch main');
  assertDenied(bash('echo `git push origin main`', dir), 'push to protected branch main');
  assertDenied(bash('(cd x; git push origin main)', dir), 'push to protected branch main');
});

test('cd in the same command moves the branch checks', () => {
  const main = repoOn('main');
  const crew = repoOn('relaylead/x');
  assertDenied(bash(`cd "${main}" && git push`, crew), 'push to protected branch main');
  assertDenied(bash(`cd "${main}" && git push origin HEAD`, crew), 'push to protected branch main');
  assertDenied(bash(`cd "${main}" && git commit -m wip`, crew), 'commit on protected branch main');
  assertDenied(bash(`pushd "${main}" && git commit -m wip`, crew), 'commit on protected branch main');
});

test('cd to a crew worktree allows its commits and pushes', () => {
  const main = repoOn('main');
  const crew = repoOn('relaylead/x');
  assert.deepStrictEqual(bash(`cd "${crew}" && git commit -m wip`, main), ALLOW);
  assert.deepStrictEqual(bash(`cd "${crew}" && git add -A && git push`, main), ALLOW);
});

test('a cd that may not have happened keeps the first folder possible', () => {
  const main = repoOn('main');
  const crew = repoOn('relaylead/x');
  const missing = path.join(tmpDir(), 'missing');
  assertDenied(bash(`cd "${missing}"; git push`, main), 'push to protected branch main');
  assertDenied(bash(`cd "${missing}" && true; git push`, main), 'push to protected branch main');
  assertDenied(bash(`(cd "${crew}"); git commit -m wip`, main), 'commit on protected branch main');
  assertDenied(bash(`cd "${crew}" | true; git commit -m wip`, main), 'commit on protected branch main');
  assertDenied(bash('cd "$DIR" && git push', crew), 'push to a branch that cannot be judged');
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
  assert.deepStrictEqual(bash('git push', repoOn('relaylead/x')), ALLOW);
});

test('bare git push outside a repository is allowed', () => {
  assert.deepStrictEqual(bash('git push', tmpDir('relaylead not a repo-')), ALLOW);
});

test('bare git push -C, --git-dir or --work-tree on main is refused', () => {
  const main = repoOn('main');
  const crew = repoOn('relaylead/x');
  assertDenied(bash(`git -C "${main}" push`, crew), 'push to protected branch main');
  assertDenied(bash(`git --git-dir "${path.join(main, '.git')}" push`, crew), 'push to protected branch main');
  assertDenied(bash(`git --work-tree="${main}" -C "${main}" commit -m x`, crew), 'commit on protected branch main');
});

test('git push --all and --mirror are refused', () => {
  const dir = repoOn('relaylead/x');
  assertDenied(bash('git push --all origin', dir), 'push of every branch');
  assertDenied(bash('git push --mirror origin', dir), 'push of every branch');
  assertDenied(bash('git push --al origin', dir), 'push of every branch');
});

test('git push -f is refused', () => {
  const dir = repoOn('relaylead/x');
  assertDenied(bash('git push -f', dir), 'force push');
  assertDenied(bash('git push --force origin relaylead/x', dir), 'force push');
  assertDenied(bash('git push --forc origin relaylead/x', dir), 'force push');
  assertDenied(bash('git push --force-with-lease origin relaylead/x', dir), 'force push');
  assertDenied(bash('git push --force-with-lease=relaylead/x origin relaylead/x', dir), 'force push');
  assertDenied(bash('git push origin +relaylead/x', dir), 'force push');
  assertDenied(bash('git push -uf origin relaylead/x', dir), 'force push');
});

test('git commit on a protected branch is refused', () => {
  assertDenied(bash('git commit -m "wip"', repoOn('main')), 'commit on protected branch main');
  assertDenied(bash('git add -A && git commit -m wip', repoOn('main')), 'commit on protected branch main');
  assertDenied(bash('timeout 5 git commit -m x', repoOn('main')), 'commit on protected branch main');
});

test('git commit on a crew branch is allowed', () => {
  assert.deepStrictEqual(bash('git commit -m "wip"', repoOn('relaylead/x')), ALLOW);
});

test('cat .env is refused', () => {
  const dir = tmpDir();
  assertDenied(bash('cat .env', dir), 'access to secret file .env');
  assertDenied(bash('cat ./.env', dir), 'access to secret file .env');
  assertDenied(bash('cp config/.env.local /tmp/x', dir), 'access to secret file .env.local');
  assertDenied(bash('node --env-file=.env app.js', dir), 'access to secret file .env');
  assertDenied(bash('docker compose --env-file .env up -d', dir), 'access to secret file .env');
  assertDenied(bash('npm run build -- --configuration=.env.production', dir), 'access to secret file .env.production');
  assertDenied(bash("grep KEY '.env'", dir), 'access to secret file .env');
  assertDenied(bash('head -c 100 < .env', dir), 'access to secret file .env');
  assertDenied(bash('echo KEY=1 >> .env', dir), 'access to secret file .env');
  assertDenied(bash('cp .env.example .env', dir), 'access to secret file .env');
});

test('a glob that may name a secret is refused', () => {
  const dir = tmpDir();
  assertDenied(bash('cat .env*', dir), 'access to secret file .env*');
  assertDenied(bash('cat .e?v', dir), 'access to secret file .e?v');
  assertDenied(bash('cat .[e]nv', dir), 'access to secret file .[e]nv');
  assertDenied(bash('cat config/.*', dir), 'access to secret file .*');
  // Like the shell, a leading * or ? does not match a name that starts with a dot.
  assert.deepStrictEqual(bash('ls src/* *.md', dir), ALLOW);
});

test('a secret name in another case is refused where the file system ignores case', () => {
  const result = bash('cat .ENV', tmpDir());
  if (CASE_INSENSITIVE) assertDenied(result, 'access to secret file .ENV');
  else assert.deepStrictEqual(result, ALLOW);
});

test('commands that only mention a secret are allowed', () => {
  const dir = repoOn('relaylead/x');
  assert.deepStrictEqual(bash('cat README.md config/app.env.md', dir), ALLOW);
  assert.deepStrictEqual(bash('echo .environment', dir), ALLOW);
  assert.deepStrictEqual(bash('echo ".env" >> .gitignore', dir), ALLOW);
  assert.deepStrictEqual(bash('grep -n "\\.env" README.md', dir), ALLOW);
  assert.deepStrictEqual(bash('git commit -m .env', dir), ALLOW);
  assert.deepStrictEqual(bash('git commit -am "feat(config): read .env at startup"', dir), ALLOW);
  const heredoc = 'git commit -m "$(cat <<\'EOF\'\nfeat: config\n\nreads .env at startup, then git push origin main\nEOF\n)"';
  assert.deepStrictEqual(bash(heredoc, dir), ALLOW);
});

test('a heredoc outside a commit message is judged', () => {
  const dir = repoOn('relaylead/x');
  assertDenied(bash('bash <<EOF\ngit push origin main\nEOF', dir), 'push to protected branch main');
});

test('example env files are not secrets', () => {
  const dir = tmpDir();
  assert.deepStrictEqual(bash('cat .env.example .env.sample .env.template', dir), ALLOW);
  const read = checkToolUse({ tool_name: 'Read', tool_input: { file_path: '/p/.env.example' }, cwd: dir }, GUARD);
  assert.deepStrictEqual(read, ALLOW);
  const strict = { ...GUARD, secretExceptions: [] };
  assertDenied(bash('cat .env.example', dir, strict), 'access to secret file .env.example');
});

test('a Read of .env is refused', () => {
  const read = (file_path) => checkToolUse({ tool_name: 'Read', tool_input: { file_path }, cwd: tmpDir() }, GUARD);
  assertDenied(read(path.join(tmpDir(), '.env')), 'access to secret file .env');
  assertDenied(read('/project/.env/'), 'access to secret file .env');
  assert.deepStrictEqual(read('/project/src/env.js'), ALLOW);
});

test('a Write, Edit, NotebookEdit or Grep of a secret is refused', () => {
  const use = (tool_name, field) =>
    checkToolUse({ tool_name, tool_input: { [field]: '/project/.env.production' }, cwd: tmpDir() }, GUARD);
  assertDenied(use('Write', 'file_path'), 'access to secret file .env.production');
  assertDenied(use('Edit', 'file_path'), 'access to secret file .env.production');
  assertDenied(use('NotebookEdit', 'notebook_path'), 'access to secret file .env.production');
  assertDenied(use('Grep', 'path'), 'access to secret file .env.production');
});

test('the mission state folder is refused', () => {
  const stateDir = path.join(tmpDir('relaylead home-'), 'missions', 'demo');
  const cwd = tmpDir();
  const use = (tool_name, tool_input) => checkToolUse({ tool_name, tool_input, cwd }, GUARD, stateDir);
  const reason = 'access to the mission state folder';
  assertDenied(use('Write', { file_path: path.join(stateDir, 'mission.json') }), reason);
  assertDenied(use('Grep', { pattern: 'x', path: stateDir }), reason);
  assertDenied(use('Bash', { command: `cat "${path.join(stateDir, 'state.json')}"` }), reason);
  assertDenied(use('Bash', { command: `cd "${stateDir}" && ls` }), reason);
  assert.deepStrictEqual(use('Write', { file_path: path.join(stateDir + '-other', 'mission.json') }), ALLOW);
  assert.deepStrictEqual(use('Bash', { command: 'relaylead task done a --mission demo' }), ALLOW);
});

test('the mission guard decides the protected branches and the secrets', () => {
  const guard = { ...GUARD, protectedBranches: ['release/*'], secrets: ['*.pem'] };
  const check = (command) => bash(command, tmpDir(), guard);
  assertDenied(check('git push origin release/1.0'), 'push to protected branch release/1.0');
  assert.deepStrictEqual(check('git push origin main'), ALLOW);
  assertDenied(check('cat keys/server.pem'), 'access to secret file server.pem');
  assert.deepStrictEqual(check('cat .env'), ALLOW);
});

test('other tools are allowed', () => {
  const result = checkToolUse({ tool_name: 'Glob', tool_input: { pattern: '**/*.js' }, cwd: tmpDir() }, GUARD);
  assert.deepStrictEqual(result, ALLOW);
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
  assert.strictEqual(request('Bash', { command: 'git commit -m "feat(guard): refuse pushes; and more"' }), true);
  assert.strictEqual(request('Bash', { command: 'git status $(rm -r src)' }), false);
  assert.strictEqual(request('Bash', { command: 'git status `rm -r src`' }), false);
  assert.strictEqual(request('Bash', { command: 'git push origin "$(git branch --show-current)"' }), true);
  const heredoc = 'git commit -m "$(cat <<\'EOF\'\nfeat: x\n\nbody\nEOF\n)"';
  assert.strictEqual(request('Bash', { command: heredoc }), true);
  assert.strictEqual(request('Bash', { command: 'git status $(cat .npmrc)' }), false);
  assert.strictEqual(request('Write', { file_path: '/project/a.js' }), false);
  assert.strictEqual(isAllowed({ tool_name: 'Bash', tool_input: { command: 'rm -r src' } }, ['Bash']), true);
});

test('the refusal message says what to do next', () => {
  assert.strictEqual(
    denyMessage('force push'),
    'Blocked by Relaylead: force push. Continue with the rest of the task, one command per call.',
  );
});
