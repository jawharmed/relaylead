const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { run } = require('../core/cli');
const { listTasks, finishTask } = require('../core/tasks');
const { getState, readMission } = require('../core/missions');
const { listSessions, recordSession, isAlive } = require('../core/sessions');
const { readJson, writeJson } = require('../core/store');
const { missionDir } = require('../core/paths');
const fake = require('../adapters/fake');
const localMerge = require('../deliveries/local-merge');
const files = require('../deliveries/files');
const tasksDirSource = require('../sources/tasks-dir');
const { tmpDir, makeIo, waitFor } = require('../fixtures/helpers');
const { writeMission, missionReport } = require('../fixtures/missions');
const { git, gitRepo, recordingGit, lingeringGit } = require('../fixtures/git');
const { needsPipes } = require('../core/run-file');

const TASK_A = '---\ntitle: First task\n---\n\nWrite a.\n';
const TASK_B = '---\ntitle: Second task\ndepends: [a]\n---\n\nWrite b.\n';

// Fresh RELAYLEAD_HOME; every session of mission demo is stopped after the test.
function freshHome(t) {
  const home = tmpDir('relaylead-home-');
  process.env.RELAYLEAD_HOME = home;
  t.after(async () => {
    process.env.RELAYLEAD_HOME = home;
    for (const session of listSessions('demo')) await fake.stop(session);
  });
}

async function cli(args) {
  const io = makeIo();
  const code = await run(args, io);
  return { code, out: io.out.text, err: io.err.text };
}

function deliver(id) {
  return cli(['task', 'deliver', id, '--mission', 'demo']);
}

// The user's repository, with work in progress: a modified tracked file and an untracked one.
function userRepo(extraFiles) {
  const dir = gitRepo({ 'README.md': 'Project\n', ...extraFiles });
  fs.writeFileSync(path.join(dir, 'README.md'), 'Project, being edited\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'my notes\n');
  return dir;
}

// Everything the user sees in their checkout.
function checkoutState(dir) {
  return {
    branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),
    head: git(dir, 'rev-parse', 'HEAD'),
    status: git(dir, 'status', '--porcelain', '--untracked-files=all'),
    readme: fs.readFileSync(path.join(dir, 'README.md'), 'utf8'),
    notes: fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'),
  };
}

// mission.json of mission demo, without a lead, and its integration worktree.
function preparedMission(dir) {
  writeMission('demo', dir);
  const mission = readMission('demo');
  localMerge.prepareMission(mission);
  return mission;
}

// A task whose crew member committed `file` on its branch, then reported done.
function finishedTask(mission, id, file = `${id}.txt`, text = id) {
  const { cwd } = localMerge.prepareTask(mission, { id });
  fs.writeFileSync(path.join(cwd, file), text + '\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', id);
  finishTask('demo', id, { state: 'done' });
}

function integrationDir(dir) {
  return path.join(dir, '.relaylead', 'worktrees', '_integration');
}

function taskWorktree(dir, id) {
  return path.join(dir, '.relaylead', 'worktrees', id);
}

// The integration worktree is on mission.config.delivery.branch.
function merge(dir, branch) {
  git(integrationDir(dir), 'merge', '--no-ff', '--no-edit', branch);
}

test('prepareMission creates the integration worktree without touching the user checkout', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/.gitkeep': '' }); // a committed task folder, no task: the lead idles
  const before = checkoutState(dir);

  const launched = await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir]);
  assert.strictEqual(launched.code, 0, launched.err);

  const integration = integrationDir(dir);
  assert.strictEqual(git(integration, 'rev-parse', '--abbrev-ref', 'HEAD'), 'relaylead/integration');
  assert.strictEqual(git(dir, 'rev-parse', 'relaylead/integration'), before.head);
  assert.deepStrictEqual(checkoutState(dir), before);

  // A later mission on the same folder reuses the worktree and excludes .relaylead/ once.
  localMerge.prepareMission(readMission('demo'));
  const exclude = fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8');
  assert.strictEqual(exclude.split(/\r?\n/).filter((line) => line === '.relaylead/').length, 1);
  assert.deepStrictEqual(checkoutState(dir), before);
});

test('deliver merges the task branch and marks the source done', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A, 'tasks/b.md': TASK_B });
  const before = checkoutState(dir);

  // The fake lead starts each ready task, then delivers it once its crew member is done.
  const launched = await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir]);
  assert.strictEqual(launched.code, 0, launched.err);
  await waitFor(() => getState('demo') === 'done', 45000, 'the mission to be done', () => missionReport('demo'));

  assert.deepStrictEqual(
    listTasks('demo').map((task) => [task.id, task.state]),
    [
      ['a', 'delivered'],
      ['b', 'delivered'],
    ],
  );
  for (const id of ['a', 'b']) {
    assert.strictEqual(git(dir, 'show', `relaylead/integration:${id}.txt`), `fake work on ${id}`);
    assert.match(git(dir, 'show', `relaylead/integration:tasks/${id}.md`), /^state: done$/m);
  }
  const subjects = git(dir, 'log', '--format=%s', 'relaylead/integration').split('\n');
  assert.ok(subjects.includes('chore(relaylead): deliver a'), subjects.join('\n'));
  assert.ok(subjects.includes('chore(relaylead): deliver b'), subjects.join('\n'));
  assert.strictEqual(git(dir, 'log', '--merges', '--format=%s', 'relaylead/integration').split('\n').length, 2);

  assert.deepStrictEqual(checkoutState(dir), before);
  assert.strictEqual(fs.existsSync(path.join(dir, 'a.txt')), false);
});

test('deliver twice is a no-op', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const mission = preparedMission(dir);
  finishedTask(mission, 'a');

  const first = await deliver('a');
  assert.strictEqual(first.code, 0, first.err);
  assert.strictEqual(first.out, 'task a delivered\n');
  const head = git(dir, 'rev-parse', 'relaylead/integration');

  const second = await deliver('a');
  assert.strictEqual(second.code, 0, second.err);
  assert.strictEqual(second.out, 'task a already delivered\n');
  assert.strictEqual(git(dir, 'rev-parse', 'relaylead/integration'), head);
});

test('refuses a protected integration branch', async (t) => {
  freshHome(t);
  const dir = userRepo({ '.relaylead.json': JSON.stringify({ delivery: { branch: 'main' } }) });
  const before = checkoutState(dir);

  const launched = await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir]);
  assert.strictEqual(launched.code, 1, launched.err);
  assert.match(launched.err, /"main" is protected/);
  assert.strictEqual(fs.existsSync(missionDir('demo')), false);
  assert.strictEqual(fs.existsSync(path.join(dir, '.relaylead')), false);
  assert.deepStrictEqual(checkoutState(dir), before);
});

test('refuses a folder that is not a git repository', async (t) => {
  freshHome(t);
  const dir = tmpDir('relaylead project-');

  const launched = await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir]);
  assert.strictEqual(launched.code, 1, launched.err);
  assert.match(launched.err, /not the root of a git repository/);
  assert.strictEqual(fs.existsSync(missionDir('demo')), false);
});

test('files delivery checks the output folder', async (t) => {
  freshHome(t);
  const dir = fs.realpathSync.native(tmpDir('relaylead project-'));
  fs.writeFileSync(path.join(dir, '.relaylead.json'), JSON.stringify({ delivery: { type: 'files' } }));
  fs.mkdirSync(path.join(dir, 'tasks'));
  fs.writeFileSync(path.join(dir, 'tasks', 'a.md'), TASK_A);
  writeMission('demo', dir);
  const mission = readMission('demo');

  const { cwd, branch } = files.prepareTask(mission, { id: 'a' });
  assert.strictEqual(cwd, path.join(dir, 'out', 'a'));
  assert.strictEqual(branch, null);
  finishTask('demo', 'a', { state: 'done' });

  const refused = await deliver('a');
  assert.strictEqual(refused.code, 1, refused.err);
  assert.match(refused.err, /output folder .* is empty/);
  assert.strictEqual(listTasks('demo')[0].state, 'done');

  fs.writeFileSync(path.join(cwd, 'a.txt'), 'a\n');
  const delivered = await deliver('a');
  assert.strictEqual(delivered.code, 0, delivered.err);
  assert.strictEqual(listTasks('demo')[0].state, 'delivered');
  assert.strictEqual(readJson(path.join(missionDir('demo'), 'tasks', 'a.json')).state, 'delivered');
});

test('deliver removes the task worktree and branch', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const mission = preparedMission(dir);
  finishedTask(mission, 'a');
  const worktree = path.join(dir, '.relaylead', 'worktrees', 'a');
  assert.ok(fs.existsSync(worktree));

  const delivered = await deliver('a');
  assert.strictEqual(delivered.code, 0, delivered.err);

  assert.strictEqual(fs.existsSync(worktree), false);
  assert.strictEqual(git(dir, 'branch', '--list', 'relaylead/demo/a'), '');
  const worktrees = git(dir, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '));
  assert.strictEqual(worktrees.length, 2, 'only the user checkout and the integration worktree remain');
});

test('a merge conflict is aborted and the task stays done', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A, 'tasks/c.md': TASK_A });
  const mission = preparedMission(dir);
  finishedTask(mission, 'a', 'shared.txt', 'from a');
  finishedTask(mission, 'c', 'shared.txt', 'from c');
  const first = await deliver('a');
  assert.strictEqual(first.code, 0, first.err);

  const refused = await deliver('c');
  assert.strictEqual(refused.code, 1, refused.err);
  assert.match(refused.err, /conflict/);
  assert.strictEqual(listTasks('demo').find((task) => task.id === 'c').state, 'done');
  assert.strictEqual(git(integrationDir(dir), 'status', '--porcelain'), '');
  assert.strictEqual(git(dir, 'show', 'relaylead/integration:shared.txt'), 'from a');
});

test('a delivery interrupted after the merge is finished by the next deliver', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const mission = preparedMission(dir);
  finishedTask(mission, 'a');
  // Crash after the merge and the mark, before the commit.
  merge(dir, 'relaylead/demo/a');
  tasksDirSource.markDone(integrationDir(dir), 'tasks', 'a');

  const replayed = await deliver('a');
  assert.strictEqual(replayed.code, 0, replayed.err);
  assert.strictEqual(replayed.out, 'task a already delivered\n');
  assert.strictEqual(git(integrationDir(dir), 'status', '--porcelain'), '');
  assert.strictEqual(git(dir, 'log', '-1', '--format=%s', 'relaylead/integration'), 'chore(relaylead): deliver a');
  assert.strictEqual(fs.existsSync(taskWorktree(dir, 'a')), false);
  assert.strictEqual(git(dir, 'branch', '--list', 'relaylead/demo/a'), '');
});

test('a delivery whose cleanup failed succeeds and is cleaned up by the next deliver', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const mission = preparedMission(dir);
  finishedTask(mission, 'a');
  // Like a process still working in the folder on Windows: the worktree cannot be removed.
  git(dir, 'worktree', 'lock', taskWorktree(dir, 'a'));

  const delivered = await deliver('a');
  assert.strictEqual(delivered.code, 0, delivered.err);
  assert.strictEqual(delivered.out, 'task a delivered\n');
  assert.match(delivered.err, /could not be cleaned up/);
  assert.strictEqual(listTasks('demo')[0].state, 'delivered');
  assert.strictEqual(git(dir, 'show', 'relaylead/integration:a.txt'), 'a');

  git(dir, 'worktree', 'unlock', taskWorktree(dir, 'a'));
  const replayed = await deliver('a');
  assert.strictEqual(replayed.code, 0, replayed.err);
  assert.strictEqual(replayed.out, 'task a already delivered\n');
  assert.strictEqual(fs.existsSync(taskWorktree(dir, 'a')), false);
  assert.strictEqual(git(dir, 'branch', '--list', 'relaylead/demo/a'), '');
});

// The result a crew member writes with `relaylead task done`, written here directly: `task done`
// refuses the work these tests deliver, but a worktree may still change after it.
function reportDone(id) {
  writeJson(path.join(missionDir('demo'), 'tasks', `${id}.result.json`), { id, state: 'done', summary: null });
}

test('task done refuses work not committed or with no commit; task fail is allowed', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A, 'tasks/c.md': TASK_A });
  const mission = preparedMission(dir);
  const { cwd } = localMerge.prepareTask(mission, { id: 'a' });
  localMerge.prepareTask(mission, { id: 'c' });
  const done = (id) => cli(['task', 'done', id, '--mission', 'demo']);

  const empty = await done('a');
  assert.strictEqual(empty.code, 1, empty.err);
  assert.match(empty.err, /no commit/);

  fs.writeFileSync(path.join(cwd, 'a.txt'), 'a\n');
  git(cwd, 'add', 'a.txt');
  git(cwd, 'commit', '-q', '-m', 'a');
  fs.writeFileSync(path.join(cwd, 'package-lock.json'), '{}\n'); // left untracked by an npm install
  const dirty = await done('a');
  assert.strictEqual(dirty.code, 1, dirty.err);
  assert.match(dirty.err, /not committed/);
  assert.match(dirty.err, /git status/);
  assert.strictEqual(listTasks('demo')[0].state, 'todo');

  fs.rmSync(path.join(cwd, 'package-lock.json'));
  const accepted = await done('a');
  assert.strictEqual(accepted.code, 0, accepted.err);
  const failed = await cli(['task', 'fail', 'c', '--mission', 'demo']);
  assert.strictEqual(failed.code, 0, failed.err);
  assert.deepStrictEqual(listTasks('demo').map((task) => task.state), ['done', 'failed']);
});

test('refuses to deliver uncommitted or empty work', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A, 'tasks/c.md': TASK_A });
  const mission = preparedMission(dir);
  // a: the crew member wrote its file but did not commit it.
  const { cwd } = localMerge.prepareTask(mission, { id: 'a' });
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'a\n');
  reportDone('a');
  // c: the crew member did nothing.
  localMerge.prepareTask(mission, { id: 'c' });
  reportDone('c');

  const uncommitted = await deliver('a');
  assert.strictEqual(uncommitted.code, 1, uncommitted.err);
  assert.match(uncommitted.err, /not committed/);
  assert.strictEqual(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'a\n');

  const empty = await deliver('c');
  assert.strictEqual(empty.code, 1, empty.err);
  assert.match(empty.err, /no commit/);

  assert.deepStrictEqual(
    listTasks('demo').map((task) => task.state),
    ['done', 'done'],
  );
});

test('refuses a task worktree on another branch', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const mission = preparedMission(dir);
  // Left by an older mission on the same folder.
  git(dir, 'worktree', 'add', '-q', '-b', 'relaylead/old/a', taskWorktree(dir, 'a'), 'relaylead/integration');

  assert.throws(() => localMerge.prepareTask(mission, { id: 'a' }), { code: 'worktree-mismatch' });
});

test('refuses to deliver a task whose branch is gone', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const mission = preparedMission(dir);
  finishedTask(mission, 'a');
  git(dir, 'worktree', 'remove', '--force', taskWorktree(dir, 'a'));
  git(dir, 'branch', '-D', 'relaylead/demo/a');

  const refused = await deliver('a');
  assert.strictEqual(refused.code, 1, refused.err);
  assert.match(refused.err, /branch relaylead\/demo\/a is missing/);
  assert.strictEqual(listTasks('demo')[0].state, 'done');
});

test('refuses an integration branch that clashes with the task branches', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  writeMission('integration', dir); // its tasks would be relaylead/integration/<id>
  assert.throws(() => localMerge.prepareMission(readMission('integration')), { code: 'branch-clash' });

  writeMission('demo', dir);
  const mission = readMission('demo');
  mission.config.delivery.branch = 'relaylead/demo/all';
  assert.throws(() => localMerge.prepareMission(mission), { code: 'branch-clash' });
});

test('refuses an integration worktree on another branch', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  preparedMission(dir);

  writeMission('two', dir);
  const second = readMission('two');
  second.config.delivery.branch = 'relaylead/other';
  assert.throws(() => localMerge.prepareMission(second), { code: 'integration-mismatch' });
});

test('refuses tasks not committed in the user checkout', async (t) => {
  freshHome(t);
  const modified = userRepo({ 'tasks/a.md': TASK_A });
  fs.writeFileSync(path.join(modified, 'tasks', 'a.md'), TASK_A + 'More.\n');
  const refused = await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', modified]);
  assert.strictEqual(refused.code, 1, refused.err);
  assert.match(refused.err, /not committed/);
  assert.strictEqual(fs.existsSync(missionDir('demo')), false);

  const missing = userRepo({});
  writeMission('demo', missing);
  assert.throws(() => localMerge.prepareMission(readMission('demo')), { code: 'tasks-not-committed' });
});

// A git hook of the user's repository, shared by all its worktrees. POSIX sh: Git for Windows runs
// it through its own shell.
function writeHook(dir, name, lines) {
  const file = path.join(dir, '.git', 'hooks', name);
  fs.writeFileSync(file, ['#!/bin/sh', ...lines, ''].join('\n'));
  fs.chmodSync(file, 0o755);
}

function removeHook(dir, name) {
  fs.rmSync(path.join(dir, '.git', 'hooks', name));
}

test('relaylead commits run the git hooks by default', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const mission = preparedMission(dir);
  finishedTask(mission, 'a');
  const witness = path.join(tmpDir('relaylead-hooks-'), 'ran.txt');
  for (const hook of ['pre-merge-commit', 'pre-commit']) writeHook(dir, hook, [`echo ${hook} >> '${witness}'`]);

  const delivered = await deliver('a');
  assert.strictEqual(delivered.code, 0, delivered.err);
  const ran = fs.readFileSync(witness, 'utf8');
  assert.match(ran, /pre-merge-commit/);
  assert.match(ran, /pre-commit/);
});

test('a failing hook stops the delivery with its output and the task stays done', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const mission = preparedMission(dir);
  finishedTask(mission, 'a');
  writeHook(dir, 'pre-merge-commit', ['echo "lint failed" >&2', 'exit 1']);

  const refused = await deliver('a');
  assert.strictEqual(refused.code, 1, refused.err);
  assert.match(refused.err, /lint failed/);
  assert.match(refused.err, /--no-hooks/);
  assert.doesNotMatch(refused.err, /\.\. /, 'git\'s last sentence and the text after the output make one period');
  const integration = integrationDir(dir);
  assert.strictEqual(git(integration, 'status', '--porcelain'), '');
  assert.strictEqual(fs.existsSync(path.resolve(integration, git(integration, 'rev-parse', '--git-path', 'MERGE_HEAD'))), false);
  assert.strictEqual(listTasks('demo')[0].state, 'done');

  removeHook(dir, 'pre-merge-commit');
  const delivered = await deliver('a');
  assert.strictEqual(delivered.code, 0, delivered.err);
  assert.strictEqual(git(dir, 'show', 'relaylead/integration:a.txt'), 'a');
});

// A hook that formats a merged file then refuses: git cannot cancel that merge with merge --abort.
test('a hook that changes a merged file then refuses leaves the integration worktree clean', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const mission = preparedMission(dir);
  finishedTask(mission, 'a');
  writeHook(dir, 'pre-merge-commit', ['echo formatted >> a.txt', 'echo "format changed a.txt" >&2', 'exit 1']);

  const refused = await deliver('a');
  assert.strictEqual(refused.code, 1, refused.err);
  assert.match(refused.err, /a git hook \(or git itself\) refused/);
  assert.match(refused.err, /format changed a\.txt/);
  const integration = integrationDir(dir);
  assert.strictEqual(fs.existsSync(path.resolve(integration, git(integration, 'rev-parse', '--git-path', 'MERGE_HEAD'))), false);
  assert.strictEqual(git(integration, 'status', '--porcelain', '--untracked-files=no'), '');
  assert.strictEqual(listTasks('demo')[0].state, 'done');

  removeHook(dir, 'pre-merge-commit');
  const delivered = await deliver('a');
  assert.strictEqual(delivered.code, 0, delivered.err);
  assert.strictEqual(git(dir, 'show', 'relaylead/integration:a.txt'), 'a');
});

// Changes made before the merge (here a line not committed) must not be lost to a reset.
test('a merge git cannot cancel over earlier changes is left to the user', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const mission = preparedMission(dir);
  finishedTask(mission, 'a');
  const integration = integrationDir(dir);
  fs.appendFileSync(path.join(integration, 'README.md'), 'not committed yet\n');
  writeHook(dir, 'pre-merge-commit', ['echo formatted >> a.txt', 'exit 1']);

  const refused = await deliver('a');
  assert.strictEqual(refused.code, 1, refused.err);
  assert.match(refused.err, /left in the middle of a merge that git could not cancel/);
  assert.match(fs.readFileSync(path.join(integration, 'README.md'), 'utf8'), /not committed yet/);
  assert.strictEqual(listTasks('demo')[0].state, 'done');
});

test('a hook refusing the update of the integration branch at launch is reported', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  preparedMission(dir);
  fs.writeFileSync(path.join(dir, 'tasks', 'b.md'), TASK_B);
  git(dir, 'add', 'tasks');
  git(dir, 'commit', '-q', '-m', 'task b');
  writeHook(dir, 'pre-merge-commit', ['echo "lint failed" >&2', 'exit 1']);

  writeMission('two', dir);
  assert.throws(() => localMerge.prepareMission(readMission('two')), (err) => {
    assert.strictEqual(err.code, 'launch-hook-failed');
    assert.match(err.vars.output, /lint failed/);
    assert.match(err.message, /"runHooks": false/);
    return true;
  });
  const integration = integrationDir(dir);
  assert.strictEqual(git(integration, 'status', '--porcelain'), '');
  assert.strictEqual(fs.existsSync(path.resolve(integration, git(integration, 'rev-parse', '--git-path', 'MERGE_HEAD'))), false);
});

test('deliver --no-hooks is for the user only and skips the hooks', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const mission = preparedMission(dir);
  finishedTask(mission, 'a');
  writeHook(dir, 'pre-merge-commit', ['echo "lint failed" >&2', 'exit 1']);
  const args = ['task', 'deliver', 'a', '--no-hooks', '--mission', 'demo'];

  const io = makeIo({ env: { RELAYLEAD_MISSION: 'demo' } });
  assert.strictEqual(await run(args, io), 1);
  assert.match(io.err.text, /"relaylead task deliver --no-hooks" belongs to the user/);
  assert.strictEqual(listTasks('demo')[0].state, 'done');

  const delivered = await cli(args);
  assert.strictEqual(delivered.code, 0, delivered.err);
  assert.strictEqual(git(dir, 'show', 'relaylead/integration:a.txt'), 'a');
});

// A merge runs pre-merge-commit, not pre-commit: only the state line commit is refused here.
test('a hook refusing the state line commit is a warning, and the next deliver commits it', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const mission = preparedMission(dir);
  finishedTask(mission, 'a');
  writeHook(dir, 'pre-commit', ['echo "no commit today" >&2', 'exit 1']);

  const delivered = await deliver('a');
  assert.strictEqual(delivered.code, 0, delivered.err);
  assert.strictEqual(delivered.out, 'task a delivered\n');
  assert.match(delivered.err, /state line commit/);
  assert.match(delivered.err, /no commit today/);
  assert.strictEqual(git(dir, 'show', 'relaylead/integration:a.txt'), 'a');
  assert.notStrictEqual(git(integrationDir(dir), 'status', '--porcelain', '--', 'tasks/a.md'), '');

  removeHook(dir, 'pre-commit');
  const replayed = await deliver('a');
  assert.strictEqual(replayed.code, 0, replayed.err);
  assert.strictEqual(replayed.err, '');
  assert.strictEqual(git(dir, 'log', '-1', '--format=%s', 'relaylead/integration'), 'chore(relaylead): deliver a');
  assert.strictEqual(git(integrationDir(dir), 'status', '--porcelain'), '');
});

test('delivery.runHooks false skips the git hooks', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A, '.relaylead.json': JSON.stringify({ delivery: { runHooks: false } }) });
  const mission = preparedMission(dir);
  finishedTask(mission, 'a');
  for (const hook of ['pre-commit', 'pre-merge-commit', 'commit-msg']) writeHook(dir, hook, ['exit 1']);

  const delivered = await deliver('a');
  assert.strictEqual(delivered.code, 0, delivered.err);
  assert.strictEqual(git(dir, 'log', '-1', '--format=%s', 'relaylead/integration'), 'chore(relaylead): deliver a');
});

test('the state line commit follows the mission language', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A, '.relaylead.json': JSON.stringify({ language: 'fr' }) });
  const mission = preparedMission(dir);
  finishedTask(mission, 'a');

  const delivered = await deliver('a');
  assert.strictEqual(delivered.code, 0, delivered.err);
  assert.strictEqual(git(dir, 'log', '-1', '--format=%s', 'relaylead/integration'), 'chore(relaylead): a livrée');
});

test('a launch refused for missing tasks works once they are committed', async (t) => {
  freshHome(t);
  const dir = userRepo({});
  writeMission('demo', dir);
  assert.throws(() => localMerge.prepareMission(readMission('demo')), { code: 'tasks-not-committed' });
  assert.strictEqual(git(dir, 'branch', '--list', 'relaylead/*'), '');
  assert.strictEqual(fs.existsSync(path.join(dir, '.relaylead')), false);

  fs.mkdirSync(path.join(dir, 'tasks'));
  fs.writeFileSync(path.join(dir, 'tasks', 'a.md'), TASK_A);
  git(dir, 'add', 'tasks');
  git(dir, 'commit', '-q', '-m', 'tasks');
  localMerge.prepareMission(readMission('demo'));
  assert.deepStrictEqual(listTasks('demo').map((task) => task.id), ['a']);
});

test('a new mission sees the tasks committed since the integration branch was made', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  preparedMission(dir);
  fs.writeFileSync(path.join(dir, 'tasks', 'b.md'), TASK_B);
  git(dir, 'add', 'tasks');
  git(dir, 'commit', '-q', '-m', 'task b');
  const before = checkoutState(dir);

  writeMission('two', dir);
  localMerge.prepareMission(readMission('two'));
  assert.deepStrictEqual(listTasks('two').map((task) => task.id), ['a', 'b']);
  const head = git(dir, 'rev-parse', 'relaylead/integration');

  // Already up to date: no new merge commit.
  localMerge.prepareMission(readMission('two'));
  assert.strictEqual(git(dir, 'rev-parse', 'relaylead/integration'), head);
  assert.deepStrictEqual(checkoutState(dir), before);
});

test('a conflict while updating the integration branch is aborted and refused', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A, 'shared.txt': 'start\n' });
  preparedMission(dir);
  fs.writeFileSync(path.join(integrationDir(dir), 'shared.txt'), 'from the integration branch\n');
  git(integrationDir(dir), 'commit', '-q', '-a', '-m', 'integration change');
  fs.writeFileSync(path.join(dir, 'shared.txt'), 'from the user\n');
  git(dir, 'commit', '-q', '-m', 'user change', '--', 'shared.txt');

  writeMission('two', dir);
  assert.throws(() => localMerge.prepareMission(readMission('two')), { code: 'integration-sync-conflict' });
  assert.strictEqual(git(integrationDir(dir), 'status', '--porcelain'), '');
});

test('a replayed delivery keeps work done on the task branch since', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const mission = preparedMission(dir);
  finishedTask(mission, 'a');
  const cwd = taskWorktree(dir, 'a');
  git(dir, 'worktree', 'lock', cwd);
  const first = await deliver('a');
  assert.strictEqual(first.code, 0, first.err);
  git(dir, 'worktree', 'unlock', cwd);
  // Late work after the delivery: committed on the branch, and not committed.
  fs.writeFileSync(path.join(cwd, 'late.txt'), 'late\n');
  git(cwd, 'add', 'late.txt');
  git(cwd, 'commit', '-q', '-m', 'late');
  fs.writeFileSync(path.join(cwd, 'later.txt'), 'later\n');

  const replayed = await deliver('a');
  assert.strictEqual(replayed.code, 0, replayed.err);
  assert.match(replayed.err, /kept/);
  assert.strictEqual(fs.readFileSync(path.join(cwd, 'later.txt'), 'utf8'), 'later\n');
  assert.strictEqual(git(dir, 'rev-list', '--count', 'relaylead/integration..relaylead/demo/a'), '1');
});

test('the fake lead logs a delivery that keeps failing, then stops', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const launched = await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir]);
  assert.strictEqual(launched.code, 0, launched.err);
  // An untracked a.txt in the integration worktree blocks the merge of the crew's a.txt.
  fs.writeFileSync(path.join(integrationDir(dir), 'a.txt'), 'in the way\n');

  const lead = listSessions('demo').find((session) => session.role === 'lead');
  await waitFor(() => !isAlive(lead.pid), 45000, 'the lead to stop', () => missionReport('demo'));

  const log = fs.readFileSync(path.join(missionDir('demo'), `fake-lead-${lead.shortId}.log`), 'utf8');
  assert.strictEqual(log.match(/task deliver a failed/g).length, 3, log);
  assert.match(log, /a\.txt/);
  assert.strictEqual(getState('demo'), 'working');
  assert.strictEqual(listTasks('demo')[0].state, 'done');
});

test('a delivery waits for a git lock to be released', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const mission = preparedMission(dir);
  finishedTask(mission, 'a');
  // Another git command holds the integration worktree's index for a moment.
  const lock = path.resolve(integrationDir(dir), git(integrationDir(dir), 'rev-parse', '--git-path', 'index.lock'));
  fs.writeFileSync(lock, '');
  const releaser = spawn(process.execPath, ['-e', `setTimeout(() => require('fs').rmSync(${JSON.stringify(lock)}), 500)`]);
  t.after(() => releaser.kill());

  const delivered = await deliver('a');
  assert.strictEqual(delivered.code, 0, delivered.err);
  assert.strictEqual(git(dir, 'show', 'relaylead/integration:a.txt'), 'a');
});

// A merge that meets a held index.lock stops like a failed hook, with a merge in progress, but says
// "Unable to write index" (in the system's language): relaylead runs git in English to tell them apart.
test('a held index lock is retried, not taken for a hook', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const mission = preparedMission(dir);
  finishedTask(mission, 'a');
  const { LC_ALL } = process.env;
  process.env.LC_ALL = 'fr_FR.UTF-8';
  t.after(() => {
    if (LC_ALL === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = LC_ALL;
  });
  const lock = path.resolve(integrationDir(dir), git(integrationDir(dir), 'rev-parse', '--git-path', 'index.lock'));
  fs.writeFileSync(lock, '');
  const releaser = spawn(process.execPath, ['-e', `setTimeout(() => require('fs').rmSync(${JSON.stringify(lock)}), 300)`]);
  t.after(() => releaser.kill());

  const delivered = await deliver('a');
  assert.strictEqual(delivered.code, 0, delivered.err);
  assert.strictEqual(git(dir, 'show', 'relaylead/integration:a.txt'), 'a');
});

// A git that leaves a process behind (a hook's background job, a credential helper) that keeps
// its output open: relaylead must still go on as soon as git itself has ended.
const PIPES = needsPipes(process.platform, process.versions.uv) && 'pipes stay open until the timeout on macOS with libuv < 1.45';
test('a git command that leaves a process behind does not hold the delivery', { skip: process.platform === 'win32' || PIPES, timeout: 20000 }, async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const mission = preparedMission(dir);
  finishedTask(mission, 'a');
  lingeringGit(t);
  process.env.RELAYLEAD_GIT_TIMEOUT_MS = '3000';
  t.after(() => {
    delete process.env.RELAYLEAD_GIT_TIMEOUT_MS;
  });

  const startedAt = Date.now();
  const delivered = await deliver('a');
  assert.strictEqual(delivered.code, 0, delivered.err);
  assert.ok(Date.now() - startedAt < 10000, `the delivery took ${Date.now() - startedAt} ms`);
  assert.strictEqual(git(dir, 'show', 'relaylead/integration:a.txt'), 'a');
});

// A git command that never ends would hold the start lock forever.
test('a git command that does not end fails the delivery in time', { skip: process.platform === 'win32', timeout: 20000 }, async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const mission = preparedMission(dir);
  finishedTask(mission, 'a');
  const bin = tmpDir('relaylead-git-');
  const leftover = path.join(bin, 'leftover.pid');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nsleep 30 &\necho $! >> '${leftover}'\nwait\n`, { mode: 0o755 });
  const { PATH } = process.env;
  process.env.PATH = bin + path.delimiter + PATH;
  process.env.RELAYLEAD_GIT_TIMEOUT_MS = '1000';
  t.after(() => {
    process.env.PATH = PATH;
    delete process.env.RELAYLEAD_GIT_TIMEOUT_MS;
    const pids = fs.existsSync(leftover) ? fs.readFileSync(leftover, 'utf8').split('\n').filter(Boolean) : [];
    for (const pid of pids) if (isAlive(Number(pid))) process.kill(Number(pid));
  });

  const startedAt = Date.now();
  const delivered = await deliver('a');
  assert.notStrictEqual(delivered.code, 0);
  assert.match(delivered.err, /did not end within 1 s/);
  assert.ok(Date.now() - startedAt < 10000, `the delivery took ${Date.now() - startedAt} ms`);
  assert.strictEqual(fs.existsSync(path.join(missionDir('demo'), 'start.lock')), false);
});

// Puts on the PATH a git that hangs on each call whose arguments contain `call`, once it has run
// `before` (shell, where $GIT is the real git); the other calls run the real git. Git's timeout
// is 1 s. Returns a function that puts back the real git and its timeout, as is done after the
// test. POSIX only (a shell script).
function hangingGit(t, call, before) {
  const bin = tmpDir('relaylead-git-');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(
    path.join(bin, 'git'),
    ['#!/bin/sh', `GIT='${realGit}'`, 'case "$*" in', `  *"${call}"*) ${before}; exec sleep 30 ;;`, 'esac', 'exec "$GIT" "$@"', ''].join('\n'),
    { mode: 0o755 },
  );
  const { PATH } = process.env;
  process.env.PATH = bin + path.delimiter + PATH;
  process.env.RELAYLEAD_GIT_TIMEOUT_MS = '1000';
  const restore = () => {
    process.env.PATH = PATH;
    delete process.env.RELAYLEAD_GIT_TIMEOUT_MS;
  };
  t.after(restore);
  return restore;
}

// Killed in the middle of a merge, git leaves the merge going and its index.lock behind: the
// integration worktree would refuse every later delivery.
test('a merge that does not end is cancelled', { skip: process.platform === 'win32', timeout: 30000 }, async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const mission = preparedMission(dir);
  finishedTask(mission, 'a');
  // The merge stops before its commit, takes the index lock, then hangs.
  const realGit = hangingGit(t, ' merge --no-ff ', '"$GIT" "$@" --no-commit; touch "$("$GIT" rev-parse --git-path index.lock)"');

  const failed = await deliver('a');
  assert.notStrictEqual(failed.code, 0);
  assert.match(failed.err, /did not end within 1 s; the merge was cancelled/);
  realGit();
  const integration = integrationDir(dir);
  assert.strictEqual(git(integration, 'status', '--porcelain'), '');
  assert.strictEqual(fs.existsSync(path.resolve(integration, git(integration, 'rev-parse', '--git-path', 'MERGE_HEAD'))), false);

  const delivered = await deliver('a');
  assert.strictEqual(delivered.code, 0, delivered.err);
  assert.strictEqual(git(dir, 'show', 'relaylead/integration:a.txt'), 'a');
});

// Killed in the middle of the state line commit, git leaves its index.lock behind: every later git
// command in the integration worktree would be refused.
test('a state line commit that does not end leaves no index.lock behind', { skip: process.platform === 'win32', timeout: 30000 }, async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const mission = preparedMission(dir);
  finishedTask(mission, 'a');
  const realGit = hangingGit(t, ' commit ', 'touch "$("$GIT" rev-parse --git-path index.lock)"');

  const delivered = await deliver('a');
  assert.strictEqual(delivered.code, 0, delivered.err);
  assert.match(delivered.err, /did not end within 1 s/);
  realGit();
  const integration = integrationDir(dir);
  assert.strictEqual(fs.existsSync(path.resolve(integration, git(integration, 'rev-parse', '--git-path', 'index.lock'))), false);

  const replayed = await deliver('a');
  assert.strictEqual(replayed.code, 0, replayed.err);
  assert.strictEqual(git(dir, 'log', '-1', '--format=%s', 'relaylead/integration'), 'chore(relaylead): deliver a');
});

test('a launch after a mission that ended with an uncommitted state line commits it', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const mission = preparedMission(dir);
  finishedTask(mission, 'a');
  writeHook(dir, 'pre-commit', ['echo "no commit today" >&2', 'exit 1']);
  const delivered = await deliver('a');
  assert.strictEqual(delivered.code, 0, delivered.err);
  assert.match(delivered.err, /state line commit/);

  writeMission('two', dir);
  assert.throws(() => localMerge.prepareMission(readMission('two')), (err) => {
    assert.strictEqual(err.code, 'launch-state-line-hook-failed');
    assert.match(err.vars.output, /no commit today/);
    return true;
  });

  removeHook(dir, 'pre-commit');
  localMerge.prepareMission(readMission('two'));
  assert.strictEqual(git(dir, 'log', '-1', '--format=%s', 'relaylead/integration'), 'chore(relaylead): deliver a');
  assert.deepStrictEqual(listTasks('two').map((task) => [task.id, task.state]), [['a', 'delivered']]);
});

test('a launch refuses an integration worktree with stray changes', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  preparedMission(dir);
  // A new task to bring in: without the check, the launch would merge it.
  fs.writeFileSync(path.join(dir, 'tasks', 'b.md'), TASK_B);
  git(dir, 'add', 'tasks');
  git(dir, 'commit', '-q', '-m', 'task b');
  fs.writeFileSync(path.join(integrationDir(dir), 'stray.txt'), 'left here\n');
  const head = git(dir, 'rev-parse', 'relaylead/integration');

  writeMission('two', dir);
  assert.throws(() => localMerge.prepareMission(readMission('two')), (err) => {
    assert.strictEqual(err.code, 'integration-dirty');
    assert.ok(err.message.includes(integrationDir(dir)), err.message);
    assert.match(err.vars.files, /stray\.txt/);
    return true;
  });
  assert.strictEqual(git(dir, 'rev-parse', 'relaylead/integration'), head);
});

test('a state line that cannot be written after the merge is a coded error, and the next deliver finishes', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const mission = preparedMission(dir);
  finishedTask(mission, 'a');
  const { markDone } = tasksDirSource;
  tasksDirSource.markDone = () => {
    tasksDirSource.markDone = markDone;
    throw new Error('disk full');
  };
  t.after(() => {
    tasksDirSource.markDone = markDone;
  });

  const failed = await deliver('a');
  assert.strictEqual(failed.code, 1);
  assert.match(failed.err, /is merged/);
  assert.match(failed.err, /disk full/);

  const delivered = await deliver('a');
  assert.strictEqual(delivered.code, 0, delivered.err);
  const merges = git(dir, 'log', '--merges', '--format=%s', 'relaylead/integration').split('\n');
  assert.strictEqual(merges.filter((subject) => subject.includes('relaylead/demo/a')).length, 1, merges.join('\n'));
});

// A background gc or maintenance started by git may keep the output pipes open, and holds the
// repository's locks: relaylead's own git commands never start one.
test('relaylead runs git without background maintenance', { skip: process.platform === 'win32' }, async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A, 'tasks/b.md': TASK_B });
  const calls = recordingGit(t);
  const mission = preparedMission(dir);
  finishedTask(mission, 'a'); // the crew's own add and commit (fixtures/git) go through it too
  const delivered = await deliver('a');
  assert.strictEqual(delivered.code, 0, delivered.err);

  // The crew's commands are its own git, left as they are.
  const own = calls().filter((call) => !/^(add -A|commit -q -m a)$/.test(call));
  assert.ok(own.length > 10, own.join('\n'));
  for (const call of own) assert.match(call, /^-c gc\.auto=0 -c maintenance\.auto=false /, call);
});

test('git messages that a short wait cures are recognised', () => {
  for (const message of [
    "fatal: Unable to create 'C:/repo/.git/index.lock': File exists.",
    "error: unable to unlink old 'a.txt': Invalid argument",
    'error: unable to unlink old a.txt: Permission denied',
    'fatal: cannot remove: Device or resource busy',
    'The process cannot access the file because it is being used by another process.',
    'error: Unable to write index.',
  ]) {
    assert.ok(localMerge.isTransientGitError(message), message);
  }
  assert.ok(!localMerge.isTransientGitError("fatal: not a git repository"));
  assert.ok(!localMerge.isTransientGitError('CONFLICT (content): Merge conflict in shared.txt'));
});

// A task worktree: `committed` adds a commit on its branch, `extra` writes files without committing.
function taskWithWork(mission, id, { committed = false, extra = {} } = {}) {
  const { cwd } = localMerge.prepareTask(mission, { id });
  if (committed) {
    fs.writeFileSync(path.join(cwd, `${id}.txt`), id + '\n');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', id);
  }
  for (const [name, text] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(cwd, name), text);
  }
  return cwd;
}

test('cleanMission removes the clean task worktrees and keeps their branches', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A, 'tasks/b.md': TASK_A, '.gitignore': 'node_modules/\n' });
  const mission = preparedMission(dir);
  taskWithWork(mission, 'a', { committed: true, extra: { 'node_modules/lib/index.js': 'ignored\n' } });
  taskWithWork(mission, 'b', { extra: { 'draft.txt': 'not committed\n' } });

  const warnings = localMerge.cleanMission(mission, {});

  assert.strictEqual(fs.existsSync(taskWorktree(dir, 'a')), false);
  assert.strictEqual(git(dir, 'branch', '--list', 'relaylead/demo/a').trim(), 'relaylead/demo/a');
  assert.strictEqual(fs.existsSync(taskWorktree(dir, 'b')), true);
  assert.deepStrictEqual(warnings.map((warning) => warning.code), ['worktree-kept']);
  assert.strictEqual(path.basename(warnings[0].vars.dir), 'b');
  assert.strictEqual(warnings[0].vars.branch, 'relaylead/demo/b');
  assert.strictEqual(fs.existsSync(integrationDir(dir)), true);
});

test('cleanMission keeps a worktree in keepDirs and goes on with the others', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A, 'tasks/b.md': TASK_A });
  const mission = preparedMission(dir);
  const busy = taskWithWork(mission, 'a', { committed: true });
  taskWithWork(mission, 'b', { committed: true });

  const warnings = localMerge.cleanMission(mission, { keepDirs: [busy] });

  assert.deepStrictEqual(warnings.map((warning) => warning.code), ['worktree-busy']);
  assert.strictEqual(path.basename(warnings[0].vars.dir), 'a');
  assert.strictEqual(fs.existsSync(taskWorktree(dir, 'a')), true);
  assert.strictEqual(fs.existsSync(taskWorktree(dir, 'b')), false);
});

test('cleanMission leaves the worktrees of other missions alone', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const mission = preparedMission(dir);
  const other = path.join(dir, '.relaylead', 'worktrees', 'other-a');
  git(dir, 'worktree', 'add', '-q', '-b', 'relaylead/other/a', other, 'relaylead/integration');
  taskWithWork(mission, 'a', { committed: true });

  const warnings = localMerge.cleanMission(mission, {});

  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(fs.existsSync(taskWorktree(dir, 'a')), false);
  assert.strictEqual(fs.existsSync(other), true);
  assert.deepStrictEqual(
    localMerge.missionWorktrees({ ...mission, name: 'other' }).map((worktree) => [path.basename(worktree.dir), worktree.branch]),
    [['other-a', 'relaylead/other/a']],
  );
});

test('stop cleans the task worktrees of its mission', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const mission = preparedMission(dir);
  taskWithWork(mission, 'a', { committed: true });

  const stopped = await cli(['stop', 'demo']);

  assert.deepStrictEqual([stopped.code, stopped.out, stopped.err], [0, 'mission demo stopped\n', '']);
  assert.strictEqual(getState('demo'), 'stopped');
  assert.strictEqual(fs.existsSync(taskWorktree(dir, 'a')), false);
  assert.strictEqual(git(dir, 'branch', '--list', 'relaylead/demo/a').trim(), 'relaylead/demo/a');
});

// A crew session of mission demo working in `cwd`, alive until stopped.
async function crewIn(cwd, number) {
  const crew = await fake.launch({
    mission: 'demo',
    name: `demo/developer/${number}`,
    role: 'crew',
    profile: null,
    prompt: '',
    cwd,
    env: { RELAYLEAD_MISSION: 'demo' },
    permissionMode: 'allowlist',
  });
  recordSession('demo', crew);
  return crew;
}

test('stop keeps the worktree of a crew session whose stop failed, and cleans the others', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A, 'tasks/b.md': TASK_A });
  const mission = preparedMission(dir);
  const first = await crewIn(taskWithWork(mission, 'a', { committed: true }), 1);
  const second = await crewIn(taskWithWork(mission, 'b', { committed: true }), 2);
  const original = fake.stop;
  fake.stop = async (session) => {
    if (session.shortId === first.shortId) throw new Error('stop failed');
    return original(session);
  };
  let stopped;
  try {
    stopped = await cli(['stop', 'demo']);
  } finally {
    fake.stop = original;
  }

  assert.strictEqual(stopped.code, 1);
  assert.match(stopped.err, /stop failed/);
  assert.match(stopped.err, /worktrees[\\/]a\b/);
  assert.strictEqual(isAlive(second.pid), false);
  assert.strictEqual(fs.existsSync(taskWorktree(dir, 'a')), true);
  assert.strictEqual(fs.existsSync(taskWorktree(dir, 'b')), false);
});

test('a session still alive after the wait keeps the folder', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/.gitkeep': '' }); // no task: the lead idles
  assert.strictEqual((await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir])).code, 0);
  await waitFor(() => getState('demo') === 'working', 30000, 'the lead to be working');
  const crew = await crewIn(taskWithWork(readMission('demo'), 'a', { committed: true }), 1);
  process.env.RELAYLEAD_STOP_WAIT_MS = '300';
  const original = fake.stop;
  fake.stop = async () => {}; // the session is asked to stop, but its process goes on
  let stopped;
  try {
    stopped = await cli(['stop', 'demo']);
  } finally {
    fake.stop = original;
    delete process.env.RELAYLEAD_STOP_WAIT_MS;
  }

  assert.strictEqual(stopped.code, 1);
  assert.match(stopped.err, /still running/);
  assert.match(stopped.err, /relaylead stop: .*worktrees[\\/]a\b/);
  assert.ok(isAlive(crew.pid));
  assert.strictEqual(readJson(path.join(missionDir('demo'), 'state.json')).stopping, true);
  assert.strictEqual(fs.existsSync(taskWorktree(dir, 'a')), true);
  const refused = await cli(['launch', '--agent', 'fake', '--name', 'two', '--dir', dir]);
  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /busy with mission "demo"/);
});

test('a stop with nothing to do still cleans', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const mission = preparedMission(dir);
  writeJson(path.join(missionDir('demo'), 'state.json'), { state: 'stopped', updatedAt: new Date().toISOString() });
  taskWithWork(mission, 'a', { committed: true });

  const stopped = await cli(['stop', 'demo']);

  assert.deepStrictEqual([stopped.code, stopped.out], [0, 'mission demo is already stopped; nothing to do\n']);
  assert.strictEqual(fs.existsSync(taskWorktree(dir, 'a')), false);
});

test('done cleans the task worktrees and notes the kept ones in the journal', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A, 'tasks/b.md': TASK_A });
  const mission = preparedMission(dir); // no lead: the test plays it
  taskWithWork(mission, 'a', { extra: { 'draft.txt': 'not committed\n' } });
  taskWithWork(mission, 'b', { committed: true });

  const done = await cli(['state', 'set', 'done', '--mission', 'demo']);

  assert.strictEqual(done.code, 0, done.err);
  assert.strictEqual(fs.existsSync(taskWorktree(dir, 'a')), true);
  assert.strictEqual(fs.existsSync(taskWorktree(dir, 'b')), false);
  const journal = fs.readFileSync(path.join(missionDir('demo'), 'journal.log'), 'utf8');
  assert.match(journal, /worktrees[\\/]a\b/);
});

test('a skipped stop keeps the worktree of a session whose recorded process still runs', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const mission = preparedMission(dir);
  await crewIn(taskWithWork(mission, 'a', { committed: true }), 1); // a live process, as far as the pid tells
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  writeJson(path.join(missionDir('demo'), 'state.json'), { state: 'stopped', stopping: true, updatedAt: twoHoursAgo });

  const stopped = await cli(['stop', 'demo']);

  assert.strictEqual(stopped.code, 0, stopped.err);
  assert.match(stopped.out, /were not stopped again/);
  assert.match(stopped.err, /relaylead stop: .*worktrees[\\/]a\b.*may still be running/);
  assert.strictEqual(fs.existsSync(taskWorktree(dir, 'a')), true);
});

test('cleanMission keeps untracked work even when git status hides untracked files', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  git(dir, 'config', 'status.showUntrackedFiles', 'no');
  const mission = preparedMission(dir);
  taskWithWork(mission, 'a', { committed: true, extra: { 'new-work.txt': 'not added yet\n' } });

  const warnings = localMerge.cleanMission(mission, {});

  assert.deepStrictEqual(warnings.map((warning) => warning.code), ['worktree-kept']);
  assert.strictEqual(fs.existsSync(path.join(taskWorktree(dir, 'a'), 'new-work.txt')), true);
});

test('cleanMission never removes the integration worktree, whatever its branch', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  writeMission('demo', dir);
  const mission = readMission('demo');
  // A branch under relaylead/demo/ is refused at launch; this one was made by hand.
  mission.config.delivery.branch = 'relaylead/demo/x';
  git(dir, 'branch', 'relaylead/demo/x');
  git(dir, 'worktree', 'add', '-q', integrationDir(dir), 'relaylead/demo/x');

  const warnings = localMerge.cleanMission(mission, {});

  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(fs.existsSync(integrationDir(dir)), true);
});

test('done keeps the worktree of a crew session listed without its folder whose stop failed', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const mission = preparedMission(dir); // no lead: the test plays it
  const crew = await crewIn(taskWithWork(mission, 'a', { committed: true }), 1);
  const originalList = fake.list;
  const originalStop = fake.stop;
  // Like a claude row with no cwd.
  fake.list = async (name) => (await originalList(name)).map(({ cwd, ...row }) => row);
  fake.stop = async (session) => {
    if (session.shortId === crew.shortId) throw new Error('stop failed');
    return originalStop(session);
  };
  let done;
  try {
    done = await cli(['state', 'set', 'done', '--mission', 'demo']);
  } finally {
    fake.list = originalList;
    fake.stop = originalStop;
  }

  assert.strictEqual(done.code, 1);
  assert.match(done.err, /stop failed/);
  assert.strictEqual(fs.existsSync(taskWorktree(dir, 'a')), true);
});

test('task done and a replayed delivery see untracked files even when git status hides them', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A, 'tasks/c.md': TASK_A });
  git(dir, 'config', 'status.showUntrackedFiles', 'no');
  const mission = preparedMission(dir);

  // task done refuses a file not added yet.
  const c = taskWithWork(mission, 'c', { committed: true, extra: { 'new-work.txt': 'not added yet\n' } });
  const refused = await cli(['task', 'done', 'c', '--mission', 'demo']);
  assert.strictEqual(refused.code, 1, refused.err);
  assert.match(refused.err, /not committed/);
  assert.strictEqual(fs.existsSync(path.join(c, 'new-work.txt')), true);

  // A replayed delivery keeps a worktree with an untracked file written since.
  finishedTask(mission, 'a');
  const a = taskWorktree(dir, 'a');
  git(dir, 'worktree', 'lock', a);
  const first = await deliver('a');
  assert.strictEqual(first.code, 0, first.err);
  git(dir, 'worktree', 'unlock', a);
  fs.writeFileSync(path.join(a, 'later.txt'), 'later\n');
  const replayed = await deliver('a');
  assert.strictEqual(replayed.code, 0, replayed.err);
  assert.match(replayed.err, /kept/);
  assert.strictEqual(fs.readFileSync(path.join(a, 'later.txt'), 'utf8'), 'later\n');
});

// The branches of mission demo, as `git branch` lists them.
function demoBranches(dir) {
  return git(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/relaylead/demo/');
}

function stopped(name) {
  writeJson(path.join(missionDir(name), 'state.json'), { state: 'stopped', updatedAt: new Date().toISOString() });
}

test('remove is refused while the mission runs', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const mission = preparedMission(dir);
  taskWithWork(mission, 'a', { committed: true });
  writeJson(path.join(missionDir('demo'), 'state.json'), { state: 'working', updatedAt: new Date().toISOString() });

  const refused = await cli(['remove', 'demo']);

  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /mission "demo" is working; stop it first with: relaylead stop demo/);
  assert.strictEqual(fs.existsSync(missionDir('demo')), true);
  assert.strictEqual(demoBranches(dir), 'relaylead/demo/a');
  assert.strictEqual(fs.existsSync(taskWorktree(dir, 'a')), true);
});

test('remove deletes the task worktrees, branches and mission folder, and keeps the integration branch', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A, 'tasks/b.md': TASK_A });
  const mission = preparedMission(dir);
  finishedTask(mission, 'a');
  assert.strictEqual((await deliver('a')).code, 0);
  taskWithWork(mission, 'b', { committed: true });
  merge(dir, 'relaylead/demo/b');
  stopped('demo');

  const removed = await cli(['remove', 'demo']);

  assert.strictEqual(removed.code, 0, removed.err);
  assert.match(removed.out, /mission demo removed\n$/);
  assert.strictEqual(fs.existsSync(missionDir('demo')), false);
  assert.strictEqual(demoBranches(dir), '');
  assert.strictEqual(fs.existsSync(taskWorktree(dir, 'b')), false);
  assert.strictEqual(git(integrationDir(dir), 'rev-parse', '--abbrev-ref', 'HEAD'), 'relaylead/integration');
  const worktrees = git(dir, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '));
  assert.strictEqual(worktrees.length, 2, 'only the user checkout and the integration worktree remain');
});

test('remove refuses work not delivered unless --force', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/b.md': TASK_A });
  const mission = preparedMission(dir);
  taskWithWork(mission, 'b', { committed: true });
  stopped('demo');
  const sha = git(dir, 'rev-parse', 'relaylead/demo/b');

  const refused = await cli(['remove', 'demo']);

  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /relaylead\/demo\/b/);
  assert.match(refused.err, /relaylead remove demo --force/);
  assert.strictEqual(fs.existsSync(missionDir('demo')), true);
  assert.strictEqual(demoBranches(dir), 'relaylead/demo/b');
  assert.strictEqual(fs.existsSync(taskWorktree(dir, 'b')), true);

  const forced = await cli(['remove', 'demo', '--force']);

  assert.strictEqual(forced.code, 0, forced.err);
  assert.strictEqual(forced.out, `deleted branch relaylead/demo/b ${sha}\nmission demo removed\n`);
  assert.strictEqual(demoBranches(dir), '');
  assert.strictEqual(fs.existsSync(missionDir('demo')), false);
});

test('remove refuses a dirty worktree unless --force', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/b.md': TASK_A });
  git(dir, 'config', 'status.showUntrackedFiles', 'no');
  const mission = preparedMission(dir);
  const b = taskWithWork(mission, 'b', { committed: true, extra: { 'draft.txt': 'not committed\n' } });
  merge(dir, 'relaylead/demo/b');
  stopped('demo');

  const refused = await cli(['remove', 'demo']);

  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /worktrees[\\/]b\b/);
  assert.strictEqual(fs.existsSync(path.join(b, 'draft.txt')), true);
  assert.strictEqual(demoBranches(dir), 'relaylead/demo/b');
  assert.strictEqual(fs.existsSync(missionDir('demo')), true);

  const forced = await cli(['remove', 'demo', '--force']);

  assert.strictEqual(forced.code, 0, forced.err);
  assert.strictEqual(fs.existsSync(b), false);
  assert.strictEqual(demoBranches(dir), '');
});

test('remove skips the delivery cleanup when the project folder is gone', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  preparedMission(dir);
  stopped('demo');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });

  const removed = await cli(['remove', 'demo']);

  assert.strictEqual(removed.code, 0, removed.err);
  assert.strictEqual(fs.existsSync(missionDir('demo')), false);
});

test('a worktree left by another mission names the mission to remove', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A, 'tasks/b.md': TASK_A });
  const mission = preparedMission(dir);
  git(dir, 'worktree', 'add', '-q', '-b', 'relaylead/old/a', taskWorktree(dir, 'a'), 'relaylead/integration');
  git(dir, 'worktree', 'add', '-q', '-b', 'mine', taskWorktree(dir, 'b'), 'relaylead/integration');
  git(dir, 'worktree', 'add', '-q', '-b', 'relaylead/demo/other', taskWorktree(dir, 'c'), 'relaylead/integration');

  assert.throws(() => localMerge.prepareTask(mission, { id: 'a' }), {
    code: 'worktree-mismatch',
    message: /relaylead remove old/,
  });
  assert.throws(() => localMerge.prepareTask(mission, { id: 'b' }), (err) => {
    assert.strictEqual(err.code, 'worktree-mismatch');
    assert.doesNotMatch(err.message, /relaylead remove/);
    assert.match(err.message, /git worktree remove/);
    return true;
  });
  // A branch of this very mission: removing the mission would not help.
  assert.throws(() => localMerge.prepareTask(mission, { id: 'c' }), (err) => {
    assert.strictEqual(err.code, 'worktree-mismatch');
    assert.doesNotMatch(err.message, /relaylead remove/);
    return true;
  });
});

test('remove --force prints each deleted branch as soon as it is deleted', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A, 'tasks/b.md': TASK_A });
  const mission = preparedMission(dir);
  taskWithWork(mission, 'a', { committed: true });
  taskWithWork(mission, 'b', { committed: true });
  stopped('demo');
  const sha = git(dir, 'rev-parse', 'relaylead/demo/a');
  // A held ref lock: deleting the second branch fails once git gives up waiting for it.
  fs.writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'relaylead', 'demo', 'b.lock'), '');

  const forced = await cli(['remove', 'demo', '--force']);

  assert.strictEqual(forced.code, 1);
  assert.match(forced.err, /relaylead\/demo\/b/);
  assert.strictEqual(forced.out, `deleted branch relaylead/demo/a ${sha}\n`);
});

test('remove counts every task branch as not delivered when the integration branch is gone', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/b.md': TASK_A });
  const mission = preparedMission(dir);
  taskWithWork(mission, 'b', { committed: true });
  merge(dir, 'relaylead/demo/b');
  stopped('demo');
  // Removed by hand.
  git(dir, 'worktree', 'remove', '--force', integrationDir(dir));
  git(dir, 'branch', '-D', 'relaylead/integration');

  const refused = await cli(['remove', 'demo']);

  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /has work not delivered: relaylead\/demo\/b;/);
  assert.strictEqual(demoBranches(dir), 'relaylead/demo/b');

  const forced = await cli(['remove', 'demo', '--force']);

  assert.strictEqual(forced.code, 0, forced.err);
  assert.strictEqual(demoBranches(dir), '');
});

test('remove refuses, even with --force, a checkout on a task branch', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/a.md': TASK_A });
  const mission = preparedMission(dir);
  taskWithWork(mission, 'a', { committed: true });
  merge(dir, 'relaylead/demo/a');
  git(dir, 'branch', 'relaylead/demo/b', 'relaylead/integration');
  git(dir, 'checkout', '-q', 'relaylead/demo/b'); // the user's own checkout
  stopped('demo');

  const refused = await cli(['remove', 'demo', '--force']);

  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /your checkout .* is on branch relaylead\/demo\/b of this mission/);
  assert.strictEqual(fs.existsSync(taskWorktree(dir, 'a')), true);
  assert.strictEqual(demoBranches(dir), 'relaylead/demo/a\nrelaylead/demo/b');
  assert.strictEqual(fs.existsSync(missionDir('demo')), true);
  // The stop's cleanup leaves the checkout alone too.
  assert.deepStrictEqual(localMerge.cleanMission(mission, {}), []);
  assert.strictEqual(fs.existsSync(taskWorktree(dir, 'a')), false);
});

test('remove keeps a locked task worktree unless --force', async (t) => {
  freshHome(t);
  const dir = userRepo({ 'tasks/b.md': TASK_A });
  const mission = preparedMission(dir);
  const b = taskWithWork(mission, 'b', { committed: true });
  merge(dir, 'relaylead/demo/b');
  git(dir, 'worktree', 'lock', b);
  stopped('demo');

  const refused = await cli(['remove', 'demo']);

  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /worktrees[\\/]b\b/);
  assert.strictEqual(fs.existsSync(b), true);

  const forced = await cli(['remove', 'demo', '--force']);

  assert.strictEqual(forced.code, 0, forced.err);
  assert.strictEqual(fs.existsSync(b), false);
  assert.strictEqual(demoBranches(dir), '');
});
