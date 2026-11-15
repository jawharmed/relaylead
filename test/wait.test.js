const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../core/cli');
const { listTasks, startTask } = require('../core/tasks');
const { listSessions, isAlive } = require('../core/sessions');
const { readJson } = require('../core/store');
const { missionDir } = require('../core/paths');
const fake = require('../adapters/fake');
const { makeIo, waitFor } = require('../fixtures/helpers');
const { setupProject, writeMission } = require('../fixtures/missions');

// Runs `relaylead wait` for mission demo and returns the parsed changes.
async function wait(timeoutSeconds) {
  const io = makeIo({ env: { RELAYLEAD_MISSION: 'demo' } });
  const code = await run(['wait', '--timeout', String(timeoutSeconds)], io);
  assert.strictEqual(code, 0, io.err.text);
  return JSON.parse(io.out.text).changes;
}

function resultFile(id) {
  return path.join(missionDir('demo'), 'tasks', `${id}.result.json`);
}

test('wait reports a finished task as a JSON change', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  const record = await startTask('demo', { id: 'a' });
  const originalStop = fake.stop;
  const stopped = [];
  fake.stop = async (session) => {
    stopped.push(session.shortId);
    return originalStop(session);
  };
  t.after(() => {
    fake.stop = originalStop;
  });

  // No snapshot yet: everything that exists is reported.
  const first = await wait(5);
  assert.deepStrictEqual(
    first.filter((change) => change.kind === 'task'),
    [
      { kind: 'task', id: 'a', from: null, to: 'running' },
      { kind: 'task', id: 'b', from: null, to: 'todo' },
    ],
  );

  // The fake crew member runs `task done a` after 1 s.
  const changes = await wait(10);
  const returnedAt = Date.now();
  assert.deepStrictEqual(
    changes.find((change) => change.kind === 'task'),
    { kind: 'task', id: 'a', from: 'running', to: 'done' },
  );
  const result = readJson(resultFile('a'));
  assert.ok(returnedAt - Date.parse(result.finishedAt) < 3000, 'wait must return within 3 s of task done');

  // The crew session whose result was read is stopped through the adapter
  // (a Claude session that is done keeps its process alive).
  assert.deepStrictEqual(stopped, [record.session]);
});

test('a change between two waits is not lost', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  const record = await startTask('demo', { id: 'a' });
  await wait(5);

  // The task finishes while nobody waits.
  await waitFor(() => fs.existsSync(resultFile('a')), 5000, 'the task result');
  const crew = listSessions('demo').find((session) => session.shortId === record.session);
  await waitFor(() => !isAlive(crew.pid), 5000, 'the crew session to end');

  const startedAt = Date.now();
  const changes = await wait(5);
  assert.ok(Date.now() - startedAt < 1000, 'the change was already there');
  assert.deepStrictEqual(changes, [
    { kind: 'task', id: 'a', from: 'running', to: 'done' },
    { kind: 'session', id: record.session, from: 'working', to: 'done' },
  ]);

  // Reported once: on timeout, wait prints no change and still succeeds.
  assert.deepStrictEqual(await wait(0), []);
});

test('crew session done without a result marks the task failed', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  const record = await startTask('demo', { id: 'a' });
  await wait(5);

  // Killed before its `task done`: the adapter now reports the session done.
  const crew = listSessions('demo').find((session) => session.shortId === record.session);
  await fake.stop(crew);
  await waitFor(() => !isAlive(crew.pid), 5000, 'the crew session to end');

  const changes = await wait(5);
  assert.deepStrictEqual(
    changes.find((change) => change.kind === 'task'),
    { kind: 'task', id: 'a', from: 'running', to: 'failed' },
  );
  const [a] = listTasks('demo');
  assert.strictEqual(a.state, 'failed');
  assert.strictEqual(a.summary, 'crew session ended without a result');
  assert.strictEqual(fs.existsSync(resultFile('a')), false);
});
