// Delivery by GitHub pull request, with a bare repository standing for GitHub and the fake gh.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const githubPr = require('../deliveries/github-pr');
const { loadConfig } = require('../core/config');
const { tmpDir } = require('../fixtures/helpers');
const { git, gitRepo } = require('../fixtures/git');
const { fakeGh, issue } = require('../fixtures/github');

const INTEGRATION = 'relaylead/integration';

// A project whose origin is a bare repository, the fake GitHub with `issues`, and a prepared mission.
function setup(t, issues) {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  const dir = gitRepo({ 'README.md': 'hello\n' });
  const remote = path.join(tmpDir('relaylead-remote-'), 'repo.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  git(dir, 'remote', 'add', 'origin', `file://${remote}`);
  git(dir, 'push', '-q', 'origin', 'main');
  const github = fakeGh(t, { remote, issues });
  const config = loadConfig({ params: { source: { type: 'github-issues' }, delivery: { type: 'github-pr' } } });
  const mission = { name: 'm', dir, config };
  githubPr.prepareMission(mission);
  return { dir, remote, github, mission };
}

// The crew member's work: one commit writing `file` on the task's branch.
function work(mission, id, file, text) {
  const { cwd } = githubPr.prepareTask(mission, { id });
  fs.writeFileSync(path.join(cwd, file), text);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', id);
  return { id, title: `Task ${id}`, summary: 'did it' };
}

function commands(github, words) {
  return github.calls().filter((call) => words.every((word, index) => call[index] === word));
}

test('deliver pushes the branch, opens and merges a pull request, deletes the branch on the remote, closes the issue', (t) => {
  const { dir, remote, github, mission } = setup(t, [issue(1, 'one')]);
  const task = work(mission, 'issue-1', 'one.txt', 'one\n');
  const warnings = githubPr.deliver(mission, task);

  const [create] = commands(github, ['pr', 'create']);
  assert.strictEqual(create[create.indexOf('--base') + 1], INTEGRATION);
  assert.strictEqual(create[create.indexOf('--head') + 1], 'relaylead/m/issue-1');
  assert.strictEqual(create[create.indexOf('--body') + 1], 'Closes #1\n\ndid it');
  const state = github.read();
  assert.strictEqual(state.prs[0].state, 'MERGED');
  assert.strictEqual(state.issues[0].state, 'CLOSED');
  assert.strictEqual(git(remote, 'show', `${INTEGRATION}:one.txt`), 'one');
  assert.strictEqual(git(dir, 'show', `${INTEGRATION}:one.txt`), 'one');
  assert.deepStrictEqual(warnings.map((warning) => [warning.code, warning.vars.url]), [['pr-merged', state.prs[0].url]]);
  assert.ok(!fs.existsSync(path.join(dir, '.relaylead', 'worktrees', 'issue-1')));
  assert.strictEqual(git(remote, 'branch', '--list', 'relaylead/m/issue-1'), '');
});

test('deliver played again after a failure past the merge opens no second pull request', (t) => {
  const { github, mission } = setup(t, [issue(1, 'one')]);
  const task = work(mission, 'issue-1', 'one.txt', 'one\n');
  process.env.FAKE_GH_FAIL = 'issue close';
  t.after(() => delete process.env.FAKE_GH_FAIL);
  assert.throws(() => githubPr.deliver(mission, task), { code: 'gh-failed' });
  delete process.env.FAKE_GH_FAIL;
  githubPr.deliver(mission, task);

  assert.strictEqual(commands(github, ['pr', 'create']).length, 1);
  assert.strictEqual(commands(github, ['pr', 'merge']).length, 1);
  assert.strictEqual(github.read().issues[0].state, 'CLOSED');
});

test('changes requested on the pull request refuse the delivery without a merge', (t) => {
  const { github, mission } = setup(t, [issue(1, 'one')]);
  const task = work(mission, 'issue-1', 'one.txt', 'one\n');
  const state = github.read();
  const url = 'https://github.com/fake/repo/pull/1';
  state.prs.push({ number: 1, head: 'relaylead/m/issue-1', base: INTEGRATION, state: 'OPEN', reviewDecision: 'CHANGES_REQUESTED', url });
  github.write(state);

  assert.throws(() => githubPr.deliver(mission, task), { code: 'pr-changes-requested' });
  assert.strictEqual(commands(github, ['pr', 'create']).length, 0);
  assert.strictEqual(commands(github, ['pr', 'merge']).length, 0);
  assert.deepStrictEqual([github.read().prs[0].state, github.read().issues[0].state], ['OPEN', 'OPEN']);
});

test('a pull request in conflict with the integration branch gives pr-merge-conflict', (t) => {
  const { remote, github, mission } = setup(t, [issue(1, 'one')]);
  // Someone else changed README.md on the integration branch on GitHub.
  const other = tmpDir('relaylead-other-');
  git(other, 'clone', '-q', '--branch', INTEGRATION, remote, '.');
  fs.writeFileSync(path.join(other, 'README.md'), 'changed on GitHub\n');
  git(other, 'commit', '-q', '-am', 'other');
  git(other, 'push', '-q', 'origin', INTEGRATION);
  const task = work(mission, 'issue-1', 'README.md', 'changed by the task\n');

  assert.throws(() => githubPr.deliver(mission, task), { code: 'pr-merge-conflict' });
  assert.strictEqual(github.read().issues[0].state, 'OPEN');
});
