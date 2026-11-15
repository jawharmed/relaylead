const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run } = require('../core/cli');
const { listTasks, startTask, finishTask, deliverTask } = require('../core/tasks');
const { getState, stopMission } = require('../core/missions');
const { listSessions, isAlive } = require('../core/sessions');
const { readJson } = require('../core/store');
const { missionDir } = require('../core/paths');
const fake = require('../adapters/fake');
const { makeIo, waitFor } = require('../fixtures/helpers');
const { setupProject, writeMission } = require('../fixtures/missions');

// Counts the launches and keeps their specs, without changing what they do.
function spyLaunches(t) {
  const original = fake.launch;
  const specs = [];
  fake.launch = async (spec) => {
    specs.push(spec);
    return original(spec);
  };
  t.after(() => {
    fake.launch = original;
  });
  return specs;
}

test('startTask launches a crew member and records the task', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  const specs = spyLaunches(t);

  const record = await startTask('demo', { id: 'a' });

  const [session] = listSessions('demo');
  assert.strictEqual(session.name, 'demo/developer/1');
  assert.strictEqual(session.role, 'crew');
  assert.deepStrictEqual(record, {
    id: 'a',
    profile: 'developer',
    state: 'running',
    session: session.shortId,
    cwd: path.join(dir, 'out', 'a'),
    branch: null,
    startedAt: record.startedAt,
  });
  assert.ok(!Number.isNaN(Date.parse(record.startedAt)));
  assert.deepStrictEqual(readJson(path.join(missionDir('demo'), 'tasks', 'a.json')), record);

  const [spec] = specs;
  assert.strictEqual(spec.env.RELAYLEAD_TASK, 'a');
  assert.strictEqual(spec.env.RELAYLEAD_MISSION, 'demo');
  assert.deepStrictEqual(spec.profile, { name: 'developer' });
  assert.match(spec.prompt, /First task/);
  assert.match(spec.prompt, /Write the first file\./);
  assert.strictEqual(spec.cwd, path.join(dir, 'out', 'a'));
  assert.ok(spec.prompt.includes('relaylead task done a --summary'));

  const tasks = listTasks('demo');
  assert.deepStrictEqual(
    tasks.map((task) => [task.id, task.state, task.ready]),
    [
      ['a', 'running', false],
      ['b', 'todo', false],
    ],
  );
});

test('startTask twice does not launch twice', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  const specs = spyLaunches(t);

  const first = await startTask('demo', { id: 'a' });
  const second = await startTask('demo', { id: 'a' });

  assert.deepStrictEqual(second, first);
  assert.strictEqual(specs.length, 1);
  assert.strictEqual(listSessions('demo').length, 1);
});

test('concurrent starts of one task launch one crew member', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  const specs = spyLaunches(t);

  const [first, second] = await Promise.all([startTask('demo', { id: 'a' }), startTask('demo', { id: 'a' })]);

  assert.deepStrictEqual(second, first);
  assert.strictEqual(specs.length, 1);
  assert.strictEqual(listSessions('demo').length, 1);
});

test('concurrent starts of two tasks give distinct session names', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);

  await Promise.all([startTask('demo', { id: 'a' }), startTask('demo', { id: 'b' })]);

  assert.deepStrictEqual(
    listSessions('demo').map((session) => session.name).sort(),
    ['demo/developer/1', 'demo/developer/2'],
  );
});

test('a stop during a launch stops the crew member', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  const original = fake.launch;
  let crew;
  fake.launch = async (spec) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    crew = await original(spec);
    return crew;
  };
  t.after(() => {
    fake.launch = original;
  });

  const starting = startTask('demo', { id: 'a' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await stopMission('demo'); // the crew member is not in the registry yet

  await assert.rejects(starting, { code: 'mission-stopped' });
  await waitFor(() => !isAlive(crew.pid), 5000, 'the crew member to be stopped');
  assert.strictEqual(fs.existsSync(path.join(missionDir('demo'), 'tasks', 'a.json')), false);
});

function startLock() {
  return path.join(missionDir('demo'), 'start.lock');
}

test('a start lock left by a dead process is taken over', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  fs.writeFileSync(startLock(), String(spawnSync(process.execPath, ['-e', '']).pid));

  await Promise.all([startTask('demo', { id: 'a' }), startTask('demo', { id: 'b' })]);

  assert.deepStrictEqual(
    listSessions('demo').map((session) => session.name).sort(),
    ['demo/developer/1', 'demo/developer/2'],
  );
  assert.strictEqual(fs.existsSync(startLock()), false);
});

test('an empty start lock older than 10 s is taken over', { timeout: 5000 }, async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  fs.writeFileSync(startLock(), ''); // its holder crashed before writing its pid
  const old = new Date(Date.now() - 11 * 1000);
  fs.utimesSync(startLock(), old, old);

  const record = await startTask('demo', { id: 'a' });
  assert.strictEqual(record.state, 'running');
});

test('a start lock that cannot be removed does not fail the start', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  // Like Windows when another process is reading the file.
  const originalRm = fs.rmSync;
  fs.rmSync = (file, options) => {
    if (String(file).endsWith('start.lock')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return originalRm(file, options);
  };
  t.after(() => {
    fs.rmSync = originalRm;
  });

  const record = await startTask('demo', { id: 'a' });
  assert.strictEqual(record.state, 'running');
  assert.deepStrictEqual(readJson(path.join(missionDir('demo'), 'tasks', 'a.json')), record);
});

test('a dependency counts once it is delivered', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  await assert.rejects(deliverTask('demo', 'a'), { code: 'task-not-deliverable' });

  finishTask('demo', 'a', { state: 'done' });
  assert.deepStrictEqual(
    listTasks('demo').map((task) => [task.id, task.state, task.ready]),
    [
      ['a', 'done', false],
      ['b', 'todo', false],
    ],
  );

  fs.mkdirSync(path.join(dir, 'out', 'a'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'out', 'a', 'a.txt'), 'a\n');
  assert.strictEqual((await deliverTask('demo', 'a')).outcome, 'delivered');
  assert.deepStrictEqual(
    listTasks('demo').map((task) => [task.id, task.state, task.ready]),
    [
      ['a', 'delivered', false],
      ['b', 'todo', true],
    ],
  );
});

test('task ids must be usable in branch names', async (t) => {
  for (const id of ['my task', '_integration', '-a', '.a', 'a..b', 'a.lock']) {
    const dir = setupProject(t, 'demo');
    writeMission('demo', dir);
    fs.writeFileSync(path.join(dir, 'tasks', `${id}.md`), '---\ntitle: Bad\n---\n');
    assert.throws(() => listTasks('demo'), { code: 'bad-task-id' }, id);
    await assert.rejects(startTask('demo', { id: 'a' }), { code: 'bad-task-id' }, id);
  }
});

test('fake mission runs two dependent tasks to done', async (t) => {
  const dir = setupProject(t, 'demo');

  const launched = await run(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir], makeIo());
  assert.strictEqual(launched, 0);
  await waitFor(() => getState('demo') === 'done', 10000, 'the mission to be done');

  assert.deepStrictEqual(
    listTasks('demo').map((task) => [task.id, task.state]),
    [
      ['a', 'delivered'],
      ['b', 'delivered'],
    ],
  );
  assert.strictEqual(fs.readFileSync(path.join(dir, 'out', 'b', 'b.txt'), 'utf8'), 'fake work on b\n');
  const tasksDir = path.join(missionDir('demo'), 'tasks');
  const aResult = readJson(path.join(tasksDir, 'a.result.json'));
  const bRecord = readJson(path.join(tasksDir, 'b.json'));
  assert.strictEqual(aResult.summary, 'fake work');
  const aRecord = readJson(path.join(tasksDir, 'a.json'));
  assert.ok(bRecord.startedAt >= aRecord.deliveredAt, 'b must start after a is delivered');
  assert.ok(aRecord.deliveredAt >= aResult.finishedAt, 'a must be delivered after it is done');
  assert.deepStrictEqual(
    listSessions('demo').map((session) => session.name).sort(),
    ['demo/developer/1', 'demo/developer/2', 'demo/lead/1'],
  );
});
