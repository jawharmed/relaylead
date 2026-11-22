// `relaylead merge`: a finished mission merged into the main branch of its project, and the crew
// member that resolves a conflict.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../core/cli');
const { readMission } = require('../core/missions');
const { listTasks } = require('../core/tasks');
const { tendMerge, OPTIONS } = require('../core/merge');
const { listQuestions } = require('../core/questions');
const { listSessions } = require('../core/sessions');
const { readJson, writeJson } = require('../core/store');
const { missionDir } = require('../core/paths');
const layout = require('../core/layout');
const localMerge = require('../deliveries/local-merge');
const fake = require('../adapters/fake');
const { tmpDir, makeIo, waitFor, killSession } = require('../fixtures/helpers');
const { placesTaken } = require('../core/places');
const { git, gitRepo } = require('../fixtures/git');
const { writeMission, missionReport } = require('../fixtures/missions');

async function cli(args) {
  const io = makeIo();
  const code = await run(args, io);
  return { code, out: io.out.text, err: io.err.text };
}

// A project on main with greet.txt, and mission demo prepared as a launch would (its integration
// branch and worktree, its branch and commit of departure), with no lead: the test plays it. Its
// sessions are stopped after the test.
function project(t) {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  writeJson(path.join(process.env.RELAYLEAD_HOME, 'config.json'), {});
  t.after(async () => {
    for (const session of listSessions('demo')) await fake.stop(session);
  });
  const dir = gitRepo({ 'README.md': 'A test project.\n', 'greet.txt': 'hello\n', 'tasks/.keep': '' });
  writeMission('demo', dir);
  const mission = readMission('demo');
  localMerge.prepareMission(mission);
  writeJson(path.join(missionDir('demo'), 'mission.json'), { ...mission, ...localMerge.launchInfo(mission) });
  return { dir, integration: layout.integrationDir(mission) };
}

function commitIn(cwd, file, text, message) {
  fs.writeFileSync(path.join(cwd, file), text);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
}

// The mission as `state set done` leaves it once its sessions are stopped.
function done() {
  writeJson(path.join(missionDir('demo'), 'state.json'), { state: 'done', note: 'all delivered', updatedAt: new Date().toISOString() });
}

function mergeRecord() {
  return readJson(path.join(missionDir('demo'), 'merge.json'), null);
}

function taskState(id) {
  const task = listTasks('demo').find((candidate) => candidate.id === id);
  return task ? task.state : null;
}

test('merge brings the integration branch into main, in the user\'s checkout on main; merged again, nothing to do', async (t) => {
  const { dir, integration } = project(t);
  commitIn(integration, 'feature.txt', 'new feature\n', 'feature');
  done();

  const merged = await cli(['merge', 'demo']);

  assert.strictEqual(merged.code, 0, merged.err);
  assert.match(merged.out, /^mission demo merged into main \([0-9a-f]{40}\)\n$/);
  assert.strictEqual(git(dir, 'show', 'main:feature.txt'), 'new feature');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'feature.txt'), 'utf8'), 'new feature\n');
  assert.strictEqual(git(dir, 'status', '--porcelain', '--untracked-files=no'), '');
  assert.strictEqual(mergeRecord().state, 'merged');
  const again = await cli(['merge', 'demo']);
  assert.strictEqual(again.code, 0, again.err);
  assert.strictEqual(again.out, 'mission demo is already in main; nothing to merge\n');
});

test('merge into a branch the user has not checked out goes through a worktree of its own; the checkout stays as it is', async (t) => {
  const { dir, integration } = project(t);
  git(dir, 'checkout', '-q', '-b', 'other');
  const head = git(dir, 'rev-parse', 'HEAD');
  commitIn(integration, 'feature.txt', 'new feature\n', 'feature');
  done();

  const merged = await cli(['merge', 'demo']);

  assert.strictEqual(merged.code, 0, merged.err);
  assert.strictEqual(git(dir, 'show', 'main:feature.txt'), 'new feature');
  assert.strictEqual(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'other');
  assert.strictEqual(git(dir, 'rev-parse', 'HEAD'), head);
  assert.ok(!fs.existsSync(path.join(dir, 'feature.txt')));
  assert.doesNotMatch(git(dir, 'worktree', 'list'), /_merge/);
});

test('merge is refused while the mission runs, and on a checkout of main with changes not committed', async (t) => {
  const { dir, integration } = project(t);
  commitIn(integration, 'feature.txt', 'new feature\n', 'feature');
  const before = git(dir, 'rev-parse', 'main');

  const running = await cli(['merge', 'demo']);
  assert.strictEqual(running.code, 1);
  assert.match(running.err, /only a done mission can be merged/);

  done();
  fs.writeFileSync(path.join(dir, 'README.md'), 'changed\n');
  const dirty = await cli(['merge', 'demo']);
  assert.strictEqual(dirty.code, 1);
  assert.match(dirty.err, /is on branch main and has changes not committed/);
  assert.strictEqual(git(dir, 'rev-parse', 'main'), before);
  assert.strictEqual(mergeRecord(), null);
});

// A conflict on greet.txt between the mission and main.
function conflict(dir, integration) {
  commitIn(integration, 'greet.txt', 'hello from the mission\n', 'mission greeting');
  commitIn(dir, 'greet.txt', 'hello from main\n', 'main greeting');
  done();
}

test('a merge in conflict is cancelled; a crew member resolves it on its branch, then the watcher merges again', async (t) => {
  const { dir, integration } = project(t);
  conflict(dir, integration);
  const before = git(dir, 'rev-parse', 'main');

  const result = await cli(['merge', 'demo']);

  assert.strictEqual(result.code, 0, result.err);
  assert.match(result.out, /conflicts with main \(greet\.txt\); the merge was cancelled and nothing changed\. A crew member resolves the conflict in task merge-into-main/);
  // Nothing half done in the user's checkout.
  assert.strictEqual(git(dir, 'rev-parse', 'main'), before);
  assert.strictEqual(git(dir, 'status', '--porcelain', '--untracked-files=no'), '');
  assert.ok(!fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD')));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'greet.txt'), 'utf8'), 'hello from main\n');
  const merge = mergeRecord();
  assert.deepStrictEqual([merge.state, merge.task, merge.conflicts, merge.attempts], ['resolving', 'merge-into-main', ['greet.txt'], 1]);
  assert.match(merge.body, /git merge main/);
  const [crew] = listSessions('demo');
  assert.strictEqual(crew.name, 'demo/developer/1');
  assert.strictEqual(crew.cwd, path.join(dir, '.relaylead', 'worktrees', 'demo', 'merge-into-main'));

  await waitFor(() => taskState('merge-into-main') === 'done', 30000, 'the resolution to be done', () => missionReport('demo'));
  await tendMerge('demo');

  assert.strictEqual(mergeRecord().state, 'merged', missionReport('demo'));
  assert.strictEqual(taskState('merge-into-main'), 'delivered');
  assert.strictEqual(git(dir, 'show', 'main:greet.txt'), 'hello from the mission');
  git(dir, 'merge-base', '--is-ancestor', 'relaylead/demo/integration', 'main');
  assert.ok(!fs.existsSync(path.join(dir, '.relaylead', 'worktrees', 'demo', 'merge-into-main')));
});

test('a failed resolution asks the user; a crew member relaunched with the hints told meanwhile resolves it', async (t) => {
  const { dir, integration } = project(t);
  conflict(dir, integration);
  const failFirst = process.env.RELAYLEAD_FAKE_FAIL_FIRST;
  process.env.RELAYLEAD_FAKE_FAIL_FIRST = 'merge-into-main';
  t.after(() => {
    if (failFirst === undefined) delete process.env.RELAYLEAD_FAKE_FAIL_FIRST;
    else process.env.RELAYLEAD_FAKE_FAIL_FIRST = failFirst;
  });

  assert.strictEqual((await cli(['merge', 'demo'])).code, 0);
  await waitFor(() => taskState('merge-into-main') === 'failed', 30000, 'the resolution to fail', () => missionReport('demo'));
  await tendMerge('demo');

  const [question] = listQuestions('demo', { state: 'open' });
  assert.match(question.text, /^The merge of mission demo into main conflicts, and the crew member could not resolve it \(fake failure\)/);
  assert.deepStrictEqual(question.options, OPTIONS);
  assert.deepStrictEqual(OPTIONS, ['Resolve it here with me', 'Relaunch a crew member with hints', 'Pause the mission']);
  assert.match(question.context, /run git merge main, fix the conflicts, run the tests and commit; then run relaylead merge demo/);
  assert.deepStrictEqual([mergeRecord().state, mergeRecord().question], ['asked', question.id]);
  // A merge already asked about is not in the way of the user's own retry.
  assert.strictEqual((await cli(['tell', 'demo', 'keep the greeting of the mission'])).code, 0);
  assert.strictEqual((await cli(['answer', 'demo', question.id, '2'])).code, 0);

  await tendMerge('demo');
  const merge = mergeRecord();
  assert.deepStrictEqual([merge.state, merge.attempts, merge.hints], ['resolving', 2, 'keep the greeting of the mission']);
  assert.match(listTasks('demo').find((task) => task.id === 'merge-into-main').body, /Hints from the user: keep the greeting of the mission/);
  await waitFor(() => taskState('merge-into-main') === 'done', 30000, 'the second resolution to be done', () => missionReport('demo'));
  await tendMerge('demo');
  assert.strictEqual(mergeRecord().state, 'merged', missionReport('demo'));
  assert.strictEqual(git(dir, 'show', 'main:greet.txt'), 'hello from the mission');
});

test('"Pause the mission" leaves the merge paused; relaylead merge tries again when the user wants', async (t) => {
  const { dir, integration } = project(t);
  conflict(dir, integration);
  const failFirst = process.env.RELAYLEAD_FAKE_FAIL_FIRST;
  process.env.RELAYLEAD_FAKE_FAIL_FIRST = 'merge-into-main';
  t.after(() => {
    if (failFirst === undefined) delete process.env.RELAYLEAD_FAKE_FAIL_FIRST;
    else process.env.RELAYLEAD_FAKE_FAIL_FIRST = failFirst;
  });
  await cli(['merge', 'demo']);
  await waitFor(() => taskState('merge-into-main') === 'failed', 30000, 'the resolution to fail', () => missionReport('demo'));
  await tendMerge('demo');
  const [question] = listQuestions('demo', { state: 'open' });

  await cli(['answer', 'demo', question.id, '3']);
  await tendMerge('demo');

  assert.strictEqual(mergeRecord().state, 'paused');
  assert.strictEqual(taskState('merge-into-main'), 'failed');
  // The user resolves it by hand in the integration worktree, then merges again.
  git(integration, 'merge', '-q', '-X', 'ours', '--no-edit', 'main');
  const merged = await cli(['merge', 'demo']);
  assert.strictEqual(merged.code, 0, merged.err);
  assert.match(merged.out, /^mission demo merged into main/);
});

test('once merged, a pass of the watcher removes the mission and its worktrees; the integration branch stays', async (t) => {
  const { dir, integration } = project(t);
  commitIn(integration, 'feature.txt', 'new feature\n', 'feature');
  done();
  assert.strictEqual((await cli(['merge', 'demo'])).code, 0);

  const pass = await cli(['watcher', 'run']);

  assert.strictEqual(pass.code, 0, pass.err);
  assert.match(pass.out, / demo mission-removed integration branch merged/);
  assert.ok(!fs.existsSync(missionDir('demo')));
  assert.ok(!fs.existsSync(integration));
  assert.doesNotMatch(git(dir, 'worktree', 'list'), /_integration/);
  assert.match(git(dir, 'branch', '--list', 'relaylead/demo/integration'), /relaylead\/demo\/integration/);
});

test('a finished mission stays while its work is not merged, or when it delivered nothing; merged by hand, it goes', async (t) => {
  const { dir, integration } = project(t);
  done();
  await cli(['watcher', 'run']);
  assert.ok(fs.existsSync(path.join(missionDir('demo'), 'mission.json')), 'nothing delivered: kept');

  commitIn(integration, 'feature.txt', 'new feature\n', 'feature');
  await cli(['watcher', 'run']);
  assert.ok(fs.existsSync(path.join(missionDir('demo'), 'mission.json')), 'not merged: kept');

  git(dir, 'merge', '-q', '--no-edit', 'relaylead/demo/integration');
  await cli(['watcher', 'run']);
  assert.ok(!fs.existsSync(missionDir('demo')));
});

test('a resolution crew member that dies without a result is failed by the watcher: its place is freed and the user is asked', async (t) => {
  const { dir, integration } = project(t);
  conflict(dir, integration);
  const gate = tmpDir('relaylead-gate-');
  const before = process.env.RELAYLEAD_FAKE_CREW_GATE;
  process.env.RELAYLEAD_FAKE_CREW_GATE = gate; // the crew member waits: it never reports
  t.after(() => {
    if (before === undefined) delete process.env.RELAYLEAD_FAKE_CREW_GATE;
    else process.env.RELAYLEAD_FAKE_CREW_GATE = before;
  });
  await cli(['merge', 'demo']);
  const [crew] = listSessions('demo');
  assert.strictEqual(placesTaken(), 1);

  killSession(crew);
  await tendMerge('demo');

  assert.strictEqual(taskState('merge-into-main'), 'failed', missionReport('demo'));
  assert.strictEqual(placesTaken(), 0);
  assert.strictEqual(mergeRecord().state, 'asked');
  assert.strictEqual(listQuestions('demo', { state: 'open' }).length, 1);
});
