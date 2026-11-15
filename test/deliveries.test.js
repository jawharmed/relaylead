const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../core/cli');
const { listTasks, finishTask } = require('../core/tasks');
const { getState, readMission } = require('../core/missions');
const { listSessions } = require('../core/sessions');
const { readJson } = require('../core/store');
const { missionDir } = require('../core/paths');
const fake = require('../adapters/fake');
const localMerge = require('../deliveries/local-merge');
const files = require('../deliveries/files');
const { tmpDir, makeIo, waitFor } = require('../fixtures/helpers');
const { writeMission } = require('../fixtures/missions');
const { git, gitRepo } = require('../fixtures/git');

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

test('prepareMission creates the integration worktree without touching the user checkout', async (t) => {
  freshHome(t);
  const dir = userRepo({});
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
  await waitFor(() => getState('demo') === 'done', 15000, 'the mission to be done');

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
  assert.ok(subjects.includes('chore(relaylead): a livrée'), subjects.join('\n'));
  assert.ok(subjects.includes('chore(relaylead): b livrée'), subjects.join('\n'));
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
  assert.strictEqual(launched.code, 1);
  assert.match(launched.err, /"main" is protected/);
  assert.strictEqual(fs.existsSync(missionDir('demo')), false);
  assert.strictEqual(fs.existsSync(path.join(dir, '.relaylead')), false);
  assert.deepStrictEqual(checkoutState(dir), before);
});

test('refuses a folder that is not a git repository', async (t) => {
  freshHome(t);
  const dir = tmpDir('relaylead project-');

  const launched = await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir]);
  assert.strictEqual(launched.code, 1);
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
  assert.strictEqual(refused.code, 1);
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
  assert.strictEqual((await deliver('a')).code, 0);

  const refused = await deliver('c');
  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /conflict/);
  assert.strictEqual(listTasks('demo').find((task) => task.id === 'c').state, 'done');
  assert.strictEqual(git(integrationDir(dir), 'status', '--porcelain'), '');
  assert.strictEqual(git(dir, 'show', 'relaylead/integration:shared.txt'), 'from a');
});
