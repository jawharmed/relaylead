// The places of the machine (maxSessions) and the queue of the tasks waiting for one.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../core/cli');
const { startTask, listTasks } = require('../core/tasks');
const { startQueuedTasks } = require('../core/watcher');
const { queue, placesTaken } = require('../core/places');
const { buildOverview } = require('../core/overview');
const { listSessions } = require('../core/sessions');
const { readJson, writeJson } = require('../core/store');
const { missionDir } = require('../core/paths');
const fake = require('../adapters/fake');
const { tmpDir, makeIo, waitFor } = require('../fixtures/helpers');
const { writeMission } = require('../fixtures/missions');
const { gitRepo } = require('../fixtures/git');
const { repoLockFile } = require('../core/mission-lock');
const { sleep } = require('../core/timing');
const localMerge = require('../deliveries/local-merge');
const { t: msg } = require('../core/messages');

// A fresh home whose machine config sets maxSessions, missions delivering files. The crew members wait
// behind a gate folder until the test opens their task (RELAYLEAD_FAKE_CREW_GATE). Every session is
// stopped after the test.
function machine(t, maxSessions) {
  const home = tmpDir('relaylead-home-');
  process.env.RELAYLEAD_HOME = home;
  writeJson(path.join(home, 'config.json'), { delivery: { type: 'files' }, maxSessions });
  const gate = tmpDir('relaylead-gate-');
  const before = process.env.RELAYLEAD_FAKE_CREW_GATE;
  process.env.RELAYLEAD_FAKE_CREW_GATE = gate;
  const names = [];
  t.after(async () => {
    process.env.RELAYLEAD_HOME = home;
    if (before === undefined) delete process.env.RELAYLEAD_FAKE_CREW_GATE;
    else process.env.RELAYLEAD_FAKE_CREW_GATE = before;
    for (const name of names) for (const session of listSessions(name)) await fake.stop(session);
  });
  // A mission with independent tasks `ids`, at `priority`; no lead: the test plays it.
  const mission = (name, priority, ids) => {
    const dir = fs.realpathSync.native(tmpDir('relaylead-project-'));
    fs.mkdirSync(path.join(dir, 'tasks'));
    for (const id of ids) fs.writeFileSync(path.join(dir, 'tasks', `${id}.md`), `---\ntitle: Task ${id}\n---\n\nDo ${id}.\n`);
    writeMission(name, dir);
    const file = path.join(missionDir(name), 'mission.json');
    writeJson(file, { ...readJson(file), priority });
    names.push(name);
  };
  // Lets the crew member of task `id` work: it reports the task done within a second or two.
  const open = (id) => fs.writeFileSync(path.join(gate, id), '');
  return { mission, open };
}

function stateOf(name, id) {
  return listTasks(name).find((task) => task.id === id).state;
}

test('past maxSessions a start waits in the queue; a freed place goes to the most urgent mission, then the oldest task', async (t) => {
  const { mission, open } = machine(t, 1);
  mission('busy', 'normal', ['busy-x']);
  mission('later', 'low', ['later-x']);
  mission('norm', 'normal', ['norm-x', 'norm-y']);
  mission('urgent', 'high', ['urgent-x']);

  assert.strictEqual((await startTask('busy', { id: 'busy-x' })).state, 'running');
  for (const [name, id] of [['later', 'later-x'], ['norm', 'norm-x'], ['norm', 'norm-y'], ['urgent', 'urgent-x']]) {
    const record = await startTask(name, { id });
    assert.strictEqual(record.state, 'queued', `${name}/${id}`);
    assert.strictEqual(record.session, null);
  }
  assert.strictEqual(listSessions('later').length, 0, 'nothing launched for a queued task');
  assert.deepStrictEqual(
    queue().map((entry) => entry.id),
    ['urgent-x', 'norm-x', 'norm-y', 'later-x'],
  );
  // Started again by the lead, a queued task stays as it is.
  assert.strictEqual((await startTask('norm', { id: 'norm-x' })).state, 'queued');

  // No place is free: the watcher starts nothing.
  await startQueuedTasks();
  assert.strictEqual(stateOf('urgent', 'urgent-x'), 'queued');

  open('busy-x');
  await waitFor(() => stateOf('busy', 'busy-x') === 'done', 30000, 'busy-x to be done');
  assert.strictEqual(placesTaken(), 0);
  await startQueuedTasks();
  assert.strictEqual(stateOf('urgent', 'urgent-x'), 'running');
  assert.deepStrictEqual(queue().map((entry) => entry.id), ['norm-x', 'norm-y', 'later-x']);

  open('urgent-x');
  await waitFor(() => stateOf('urgent', 'urgent-x') === 'done', 30000, 'urgent-x to be done');
  await startQueuedTasks();
  assert.strictEqual(stateOf('norm', 'norm-x'), 'running');
  assert.strictEqual(stateOf('norm', 'norm-y'), 'queued');
  assert.strictEqual(stateOf('later', 'later-x'), 'queued');
});

test('a free place does not go to a start that a queued task of the same priority comes before', async (t) => {
  const { mission, open } = machine(t, 1);
  mission('first', 'normal', ['first-x', 'first-y']);
  mission('second', 'normal', ['second-x']);
  await startTask('first', { id: 'first-x' });
  assert.strictEqual((await startTask('first', { id: 'first-y' })).state, 'queued');

  open('first-x');
  await waitFor(() => stateOf('first', 'first-x') === 'done', 30000, 'first-x to be done');
  // A place is free, but first-y waits for it already.
  assert.strictEqual((await startTask('second', { id: 'second-x' })).state, 'queued');
  await startQueuedTasks();
  assert.strictEqual(stateOf('first', 'first-y'), 'running');
  assert.strictEqual(stateOf('second', 'second-x'), 'queued');
});

test('list and overview show the tasks waiting for a place', async (t) => {
  const { mission } = machine(t, 1);
  mission('busy', 'normal', ['busy-x']);
  mission('waiting', 'normal', ['waiting-x', 'waiting-y']);
  await startTask('busy', { id: 'busy-x' });
  await startTask('waiting', { id: 'waiting-x' });
  await startTask('waiting', { id: 'waiting-y' });

  const io = makeIo();
  assert.strictEqual(await run(['list'], io), 0, io.err.text);
  assert.match(io.out.text, /^waiting {2}starting \(2 queued\) {2}- {2}/m);
  const view = buildOverview();
  assert.deepStrictEqual(view.sessions, { running: 1, max: 1 });
  const waiting = view.missions.find((one) => one.name === 'waiting');
  assert.strictEqual(waiting.queued, 2);
  assert.deepStrictEqual(waiting.tasks.map((task) => task.state), ['queued', 'queued']);
});

test('relaylead priority changes the rank of a mission in the queue; a wrong value is refused', async (t) => {
  const { mission, open } = machine(t, 1);
  mission('busy', 'normal', ['busy-x']);
  mission('first', 'normal', ['first-x']);
  mission('second', 'normal', ['second-x']);
  await startTask('busy', { id: 'busy-x' });
  await startTask('first', { id: 'first-x' });
  await startTask('second', { id: 'second-x' });
  assert.deepStrictEqual(queue().map((entry) => entry.id), ['first-x', 'second-x']);

  const io = makeIo();
  assert.strictEqual(await run(['priority', 'second', 'high'], io), 0, io.err.text);
  assert.strictEqual(io.out.text, 'priority of second: high\n');
  assert.strictEqual(readJson(path.join(missionDir('second'), 'mission.json')).priority, 'high');
  assert.deepStrictEqual(queue().map((entry) => entry.id), ['second-x', 'first-x']);

  open('busy-x');
  await waitFor(() => stateOf('busy', 'busy-x') === 'done', 30000, 'busy-x to be done');
  await startQueuedTasks();
  assert.strictEqual(stateOf('second', 'second-x'), 'running');
  assert.strictEqual(stateOf('first', 'first-x'), 'queued');

  const wrong = makeIo();
  assert.strictEqual(await run(['priority', 'first', 'urgent'], wrong), 1);
  assert.match(wrong.err.text, /unknown priority "urgent"; use one of: high, normal, low/);
  const fromSession = makeIo({ env: { RELAYLEAD_MISSION: 'first' } });
  assert.strictEqual(await run(['priority', 'first', 'low'], fromSession), 1);
});

test('a repository whose git lock is held does not hold up the crew starts of other projects', async (t) => {
  const { mission } = machine(t, 4);
  mission('other', 'normal', ['other-x']);
  const dir = gitRepo({
    'README.md': 'A test project.\n',
    'tasks/busy-x.md': '---\ntitle: Task busy-x\n---\n\nDo busy-x.\n',
    '.relaylead.json': JSON.stringify({ delivery: { type: 'local-merge' } }),
  });
  writeMission('busy', dir);
  localMerge.prepareMission(readJson(path.join(missionDir('busy'), 'mission.json')));
  // Another command holds the git lock of that repository for longer than a start waits for it.
  const lock = repoLockFile(dir);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, command: 'task deliver z', since: new Date().toISOString() }));
  const wait = process.env.RELAYLEAD_REPO_LOCK_WAIT_MS;
  process.env.RELAYLEAD_REPO_LOCK_WAIT_MS = '3000';
  t.after(() => {
    fs.rmSync(lock, { force: true });
    if (wait === undefined) delete process.env.RELAYLEAD_REPO_LOCK_WAIT_MS;
    else process.env.RELAYLEAD_REPO_LOCK_WAIT_MS = wait;
  });

  const busy = startTask('busy', { id: 'busy-x' }).then(() => 'started', (err) => err.code);
  await sleep(300);
  const startedAt = Date.now();
  const record = await startTask('other', { id: 'other-x' });

  assert.strictEqual(record.state, 'running');
  assert.ok(Date.now() - startedAt < 2000, `the start waited ${Date.now() - startedAt} ms`);
  assert.strictEqual(await busy, 'repo-busy');
  // The refused start leaves its task as it was.
  assert.strictEqual(stateOf('busy', 'busy-x'), 'todo');
  assert.strictEqual(placesTaken(), 1);
});

test('the lead knows places-busy as a busy machine, not a failure to report', () => {
  const profile = fs.readFileSync(path.join(__dirname, '..', 'catalog', 'profiles', 'lead.md'), 'utf8');
  const vars = { command: 'task start a', pid: 1, since: '-' };
  const phrases = { en: 'has held the places of the machine for too long', fr: 'occupe les places de la machine depuis trop longtemps' };
  for (const [lang, phrase] of Object.entries(phrases)) {
    assert.ok(msg('places-busy', vars, lang).includes(phrase), lang);
    assert.ok(profile.includes(phrase), lang);
  }
});

test('the crew of a mission paused for the usage limit still takes its places; its queued tasks wait', async (t) => {
  const { mission } = machine(t, 1);
  mission('paused', 'low', ['paused-x', 'paused-y']);
  await startTask('paused', { id: 'paused-x' });
  await startTask('paused', { id: 'paused-y' });
  writeJson(path.join(missionDir('paused'), 'usage-pause.json'), { at: new Date().toISOString(), reason: 'test', resumeAt: new Date(Date.now() + 3600000).toISOString() });

  assert.strictEqual(placesTaken(), 1);
  assert.deepStrictEqual(queue(), []);
});
