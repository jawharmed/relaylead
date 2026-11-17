const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { checkToolUse, isAllowed, denyMessage } = require('../core/guard');
const { DEFAULTS } = require('../core/config');
const { tmpDir } = require('../fixtures/helpers');
const { git, gitRepo, recordingGit, lingeringGit } = require('../fixtures/git');
const { needsPipes } = require('../core/run-file');

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
  assertDenied(bash('git push origin {main,x}', dir), reason);
  assertDenied(bash('git push origin mai{n,}', dir), reason);
});

test('the value of a push option is not taken for the remote', () => {
  assertDenied(bash('git push -o ci.skip origin', repoOn('main')), 'push to protected branch main');
  assertDenied(bash('git push --repo origin', repoOn('main')), 'push to protected branch main');
  // With --repo, git takes the first word for the repository, but it may be a refspec: judged as one.
  assertDenied(bash('git push --repo origin main', repoOn('relaylead/x')), 'push to protected branch main');
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
    'git --attr-source HEAD push origin main',
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
  assertDenied(bash(`cd "${crew}" && true; git push`, main), 'push to protected branch main');
  // In the missing folder itself, git cannot read a branch.
  assertDenied(bash(`cd "${missing}" && git push`, main), 'push to an unreadable branch: current branch unknown');
  assertDenied(bash(`(cd "${crew}"); git commit -m wip`, main), 'commit on protected branch main');
  assertDenied(bash(`cd "${crew}" | true; git commit -m wip`, main), 'commit on protected branch main');
  assertDenied(bash('cd "$DIR" && git push', crew), 'push to a branch that cannot be judged');
  assertDenied(bash(`cd "${main}" || exit 1; git push`, crew), 'push to protected branch main');
  assertDenied(bash(`cd "${main}" || exit 1\ngit commit -m x`, crew), 'commit on protected branch main');
});

test('git -C dir push origin main is refused', () => {
  assertDenied(bash('git -C ../other push origin main', repoOn('relaylead/x')), 'push to protected branch main');
});

test('the guard reads the branch without background maintenance', { skip: process.platform === 'win32' }, (t) => {
  const dir = repoOn('main');
  const calls = recordingGit(t);
  assertDenied(bash('git push', dir), 'push to protected branch main');
  assert.ok(calls().length > 0);
  for (const call of calls()) assert.match(call, /^-c gc\.auto=0 -c maintenance\.auto=false /, call);
});

// A git that leaves a process behind with its output open must not slow the guard down, nor make
// the branch unreadable.
const PIPES = needsPipes(process.platform, process.versions.uv) && 'pipes stay open until the timeout on macOS with libuv < 1.45';
test('the guard reads the branch when git leaves a process behind', { skip: process.platform === 'win32' || PIPES }, (t) => {
  const dir = repoOn('main');
  lingeringGit(t);
  const startedAt = Date.now();
  assertDenied(bash('git push', dir), 'push to protected branch main');
  assert.ok(Date.now() - startedAt < 5000, `the guard took ${Date.now() - startedAt} ms`);
});

// Like relaylead's other git calls: messages in English whatever the system's language.
test('the guard runs git with LC_ALL=C', { skip: process.platform === 'win32' }, (t) => {
  const dir = repoOn('main');
  const bin = tmpDir('relaylead-git-');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const seen = path.join(bin, 'lc_all.log');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "LC_ALL=$LC_ALL" >> '${seen}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const { PATH, LC_ALL } = process.env;
  process.env.PATH = bin + path.delimiter + PATH;
  process.env.LC_ALL = 'fr_FR.UTF-8';
  t.after(() => {
    process.env.PATH = PATH;
    if (LC_ALL === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = LC_ALL;
  });

  assertDenied(bash('git push', dir), 'push to protected branch main');
  const lines = fs.readFileSync(seen, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length > 0);
  for (const line of lines) assert.strictEqual(line, 'LC_ALL=C');
});

test('bare git push on main is refused', () => {
  const dir = repoOn('main');
  assertDenied(bash('git push', dir), 'push to protected branch main');
  assertDenied(bash('git push origin', dir), 'push to protected branch main');
});

test('bare git push on a crew branch is allowed', () => {
  assert.deepStrictEqual(bash('git push', repoOn('relaylead/x')), ALLOW);
});

test('bare git push or commit where the current branch cannot be read is refused', () => {
  const notARepo = tmpDir('relaylead not a repo-');
  assertDenied(bash('git push', notARepo), 'push to an unreadable branch: current branch unknown');
  assertDenied(bash('git commit -m wip', notARepo), 'commit on an unreadable branch: current branch unknown');
});

test('bare git push on an unborn main branch is refused', () => {
  const dir = fs.realpathSync.native(tmpDir('relaylead unborn-'));
  git(dir, 'init', '-q', '-b', 'main');
  assertDenied(bash('git push', dir), 'push to protected branch main');
  assertDenied(bash('git commit -m first', dir), 'commit on protected branch main');
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
  assertDenied(bash('git push --m origin', dir), 'push of every branch');
  assertDenied(bash('git push --mi origin', dir), 'push of every branch');
  assertDenied(bash('git push --branches origin', dir), 'push of every branch');
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
  const heredoc = 'git commit -m "$(cat <<\'EOF\'\nfeat: config\n\nreads .env at startup (see .env.local)\nEOF\n)"';
  assert.deepStrictEqual(bash(heredoc, dir), ALLOW);
  assert.deepStrictEqual(bash('git commit -F - <<EOF\nfix: read .env\nEOF', dir), ALLOW);
});

test('every line is judged, even in a commit message', () => {
  // A safe-side false denial: a commit message that quotes a protected push on its own line.
  const heredoc = 'git commit -m "$(cat <<\'EOF\'\nfeat: config\n\ngit push origin main stays manual\nEOF\n)"';
  assertDenied(bash(heredoc, repoOn('relaylead/x')), 'push to protected branch main');
});

test('a comment is not a command', () => {
  const dir = repoOn('relaylead/x');
  assert.deepStrictEqual(bash('git status # then git push origin main', dir), ALLOW);
  assert.deepStrictEqual(bash('cat README.md # not .env', dir), ALLOW);
  assert.deepStrictEqual(bash('echo "#" && git status', dir), ALLOW);
  assertDenied(bash('echo a#b && git push origin main', dir), 'push to protected branch main');
});

test('a heredoc outside a commit message is judged', () => {
  const dir = repoOn('relaylead/x');
  assertDenied(bash('bash <<EOF\ngit push origin main\nEOF', dir), 'push to protected branch main');
});

test('a quoted or unclosed heredoc marker hides nothing', () => {
  const dir = repoOn('relaylead/x');
  const reason = 'push to protected branch main';
  assertDenied(bash('git commit -m "doc: <<EOF parsing"\ngit push origin main', dir), reason);
  assertDenied(bash('echo "<<EOF"; git commit -m x\ngit push origin main', dir), reason);
  assertDenied(bash("git commit -m 'a <<EOF b'\ngit push origin main\nEOF", dir), reason);
  assertDenied(bash('git commit -F - <<EOF\nmessage\ngit push origin main', dir), reason);
  assertDenied(bash('git commit -F - <<EOF\nmessage\nEOF\ngit push origin main', dir), reason);
  assertDenied(bash('git commit -F - <<EOF.x\nmsg\nEOF.x\ngit push origin main\nEOF', dir), reason);
  assertDenied(bash('git commit -F - <<EOF"x"\nmsg\nEOFx\ngit push origin main\nEOF', dir), reason);
  assertDenied(bash('true # "\ngit commit -m "<<EOF"\ngit push origin main\nEOF', dir), reason);
  assertDenied(bash("git commit -m $'\\'<<EOF'\ngit push origin main\nEOF", dir), reason);
  assertDenied(bash('git commit -m "${x#"}" -m "<<EOF"\ngit push origin main\nEOF', dir), reason);
});

test('a << that starts no heredoc hides no secret', () => {
  const dir = repoOn('relaylead/x');
  const reason = 'access to secret file .env';
  // A shift or a comparison, not a heredoc.
  assertDenied(bash('echo $((1<<2))\ncat .env', dir), reason);
  assertDenied(bash(': $((1<<2))\ncat .env\n2', dir), reason);
  assertDenied(bash('(( x = 1 << 2 ))\ncat .env', dir), reason);
  assertDenied(bash('(( x = 1 << 2 ))\ncat .env\n2', dir), reason);
  assertDenied(bash('[[ 1 << 2 ]]\ncat .env\n2', dir), reason);
  assertDenied(bash('[[ a == "]]" << 2 ]]\ncat .env\n2', dir), reason);
  // The delimiter comes after `<<-` and spaces; without a delimiter or a closing line, all is judged.
  assertDenied(bash('cat <<- EOF\nbody\nEOF\ncat .env', dir), reason);
  assertDenied(bash('cat << -EOF\nbody\n-EOF\ncat .env\nEOF', dir), reason);
  assertDenied(bash('cat <<\ncat .env', dir), reason);
  assertDenied(bash('bash <<EOF\ncat .env', dir), reason);
  assertDenied(bash('cat <<A <<B\na\nA\nb\nB\ncat .env', dir), reason);
  // A real heredoc body may still mention a secret.
  assert.deepStrictEqual(bash('cat > notes.md <<- EOF\n\tread .env first\n\tEOF\ngit status', dir), ALLOW);
  assert.deepStrictEqual(bash('cat <<A <<B\nsee .env\nA\nsee .env\nB\ngit status', dir), ALLOW);
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
  assertDenied(use('Glob', { pattern: '**/*.json', path: stateDir }), reason);
  assertDenied(use('Bash', { command: `cat "${path.join(stateDir, 'state.json')}"` }), reason);
  assertDenied(use('Bash', { command: `cd "${stateDir}" && ls` }), reason);
  assert.deepStrictEqual(use('Write', { file_path: path.join(stateDir + '-other', 'mission.json') }), ALLOW);
  assert.deepStrictEqual(use('Bash', { command: 'relaylead task done a --mission demo' }), ALLOW);
});

// A relaylead home named `.relaylead` in a temp folder, its parent, and the state folder of mission `demo`.
function stateLayout() {
  const parent = tmpDir('relaylead-parent-');
  const home = path.join(parent, '.relaylead');
  return { parent, stateDir: path.join(home, 'missions', 'demo') };
}

test('a Glob pattern that may reach the mission state folder is refused', () => {
  const { parent, stateDir } = stateLayout();
  const project = tmpDir();
  const glob = (tool_input) => checkToolUse({ tool_name: 'Glob', tool_input, cwd: project }, GUARD, stateDir);
  const reason = 'access to the mission state folder';
  assertDenied(glob({ pattern: path.join(stateDir, '*') }), reason);
  assertDenied(glob({ pattern: '**/*.json', path: parent }), reason);
  assert.deepStrictEqual(glob({ pattern: 'src/**/*.js' }), ALLOW);
  // Glob gives only names: a pattern that names a secret reads nothing.
  assert.deepStrictEqual(glob({ pattern: '**/.env' }), ALLOW);
});

test('a Grep glob naming a secret or the state folder is refused', () => {
  const { parent, stateDir } = stateLayout();
  const project = tmpDir();
  const grep = (tool_input) => checkToolUse({ tool_name: 'Grep', tool_input, cwd: project }, GUARD, stateDir);
  assertDenied(grep({ pattern: 'KEY', glob: '.env' }), 'access to secret file .env');
  // Unlike the shell, ripgrep lets a leading wildcard match a name that starts with a dot.
  assertDenied(grep({ pattern: 'KEY', glob: '*.env' }), 'access to secret file *.env');
  assertDenied(grep({ pattern: 'KEY', glob: '*.{js,env}' }), 'access to secret file *.env');
  assertDenied(grep({ pattern: 'KEY', glob: '*' }), 'access to secret file *');
  assertDenied(grep({ pattern: 'x', glob: '.relaylead/**', path: parent }), 'access to the mission state folder');
  assert.deepStrictEqual(grep({ pattern: 'x', glob: '*.{ts,js}' }), ALLOW);
});

test('the mission state folder is refused under ~, $HOME or $RELAYLEAD_HOME', (t) => {
  const reason = 'access to the mission state folder';
  // Only paths are compared: nothing is read or written under the real home folder.
  const homeState = path.join(os.homedir(), '.relaylead', 'missions', 'demo');
  const atHome = (tool_name, tool_input) => checkToolUse({ tool_name, tool_input, cwd: tmpDir() }, GUARD, homeState);
  assertDenied(atHome('Bash', { command: 'cat ~/.relaylead/missions/demo/mission.json' }), reason);
  assertDenied(atHome('Bash', { command: 'cat $HOME/.relaylead/missions/demo/mission.json' }), reason);
  assertDenied(atHome('Bash', { command: 'cat "${HOME}/.relaylead/missions/demo/state.json"' }), reason);
  assertDenied(atHome('Bash', { command: 'cd ~/.relaylead/missions/demo && ls' }), reason);
  assertDenied(atHome('Read', { file_path: '~/.relaylead/missions/demo/mission.json' }), reason);
  if (process.platform === 'win32') {
    assertDenied(atHome('Bash', { command: 'type %USERPROFILE%/.relaylead/missions/demo/mission.json' }), reason);
  }
  // Another variable, a glob, braces or ~user may lead there too: refused when the word names the
  // state folders.
  assertDenied(atHome('Bash', { command: 'cat $DATA/.relaylead/missions/demo/mission.json' }), reason);
  assertDenied(atHome('Bash', { command: 'cat ~/.relayl*/m*/demo/mission.json' }), reason);
  assertDenied(atHome('Bash', { command: 'cat ~/.relaylead/missions/dem[o]/mission.json' }), reason);
  assertDenied(atHome('Bash', { command: 'cat ~/.relaylead/{missions}/demo/mission.json' }), reason);
  assertDenied(atHome('Bash', { command: 'cat ~someone/.relaylead/missions/demo/mission.json' }), reason);
  // Braces are expanded and `~user` is read as `~` before judging.
  assertDenied(atHome('Bash', { command: 'cat ~/.relay{lead,x}/mis{sions,}/demo/mission.json' }), reason);
  assertDenied(atHome('Bash', { command: 'cat ~someone/.r*/m*/demo/mission.json' }), reason);
  assertDenied(atHome('Bash', { command: 'cat ~/.r*/*/*/mission.json' }), reason);
  assert.deepStrictEqual(atHome('Bash', { command: 'ls docs/missions ~/Workspace/*.md' }), ALLOW);
  assert.deepStrictEqual(atHome('Bash', { command: 'cat $HOME/notes.txt "$TMPDIR/a.log"' }), ALLOW);

  const home = tmpDir('relaylead home-');
  const previous = process.env.RELAYLEAD_HOME;
  process.env.RELAYLEAD_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.RELAYLEAD_HOME;
    else process.env.RELAYLEAD_HOME = previous;
  });
  const stateDir = path.join(home, 'missions', 'demo');
  const command = 'cat ${RELAYLEAD_HOME}/missions/demo/mission.json $RELAYLEAD_HOME/x';
  assertDenied(checkToolUse({ tool_name: 'Bash', tool_input: { command }, cwd: tmpDir() }, GUARD, stateDir), reason);
});

test('everyday words that contain "missions" are allowed', () => {
  const homeState = path.join(os.homedir(), '.relaylead', 'missions', 'demo');
  const dir = repoOn('relaylead/x');
  const run = (command) => checkToolUse({ tool_name: 'Bash', tool_input: { command }, cwd: dir }, GUARD, homeState);
  assert.deepStrictEqual(run('node --test test/missions*.test.js'), ALLOW);
  assert.deepStrictEqual(run('grep -E "missions?" core/*.js'), ALLOW);
  assert.deepStrictEqual(run('grep -rn "missions\\[" core/'), ALLOW);
  assert.deepStrictEqual(run('rg "missions.*demo" core'), ALLOW);
  assert.deepStrictEqual(run('jq ".missions[]" out.json'), ALLOW);
  assert.deepStrictEqual(run('ls docs/missions/*.md fixtures/missions*'), ALLOW);
  const message = 'git commit -m "$(cat <<\'EOF\'\nfix(missions): list missions/*.json\nEOF\n)"';
  assert.deepStrictEqual(run(message), ALLOW);
  // A glob that may reach the state folder is still refused.
  const inHome = { tool_name: 'Bash', tool_input: { command: 'ls missions/*' }, cwd: path.dirname(path.dirname(homeState)) };
  assertDenied(checkToolUse(inHome, GUARD, homeState), 'access to the mission state folder');
});

test('braces are expanded before judging', () => {
  const dir = repoOn('relaylead/x');
  assertDenied(bash('cat .e{nv,xample}', dir), 'access to secret file .env');
  assertDenied(bash('git push origin {main,x}', dir), 'push to a branch that cannot be judged');
  assert.deepStrictEqual(bash('ls src/{a,b}.js && find . -name x -exec cat {} \\;', dir), ALLOW);
  assertDenied(bash('cat {,}{,}{,}{,}{,}{,}{,}.e{nv,x}', dir), 'a brace expansion that cannot be judged');
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
