const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { run } = require('../core/cli');
const { listTasks, startTask } = require('../core/tasks');
const { getState } = require('../core/missions');
const { listSessions } = require('../core/sessions');
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
    cwd: dir,
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

test('fake mission runs two dependent tasks to done', async (t) => {
  const dir = setupProject(t, 'demo');

  const launched = await run(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir], makeIo());
  assert.strictEqual(launched, 0);
  await waitFor(() => getState('demo') === 'done', 10000, 'the mission to be done');

  assert.deepStrictEqual(
    listTasks('demo').map((task) => [task.id, task.state]),
    [
      ['a', 'done'],
      ['b', 'done'],
    ],
  );
  const tasksDir = path.join(missionDir('demo'), 'tasks');
  const aResult = readJson(path.join(tasksDir, 'a.result.json'));
  const bRecord = readJson(path.join(tasksDir, 'b.json'));
  assert.strictEqual(aResult.summary, 'fake work');
  assert.ok(bRecord.startedAt >= aResult.finishedAt, 'b must start after a is done');
  assert.deepStrictEqual(
    listSessions('demo').map((session) => session.name).sort(),
    ['demo/developer/1', 'demo/developer/2', 'demo/lead/1'],
  );
});
