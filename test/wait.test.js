const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../core/cli');
const { listTasks, startTask } = require('../core/tasks');
const { stopMission } = require('../core/missions');
const { listSessions } = require('../core/sessions');
const { readJson, writeJson } = require('../core/store');
const { waitForChanges } = require('../core/wait');
const { missionDir } = require('../core/paths');
const fake = require('../adapters/fake');
const { makeIo, waitFor, sessionEnded } = require('../fixtures/helpers');
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

function snapshotFile() {
  return path.join(missionDir('demo'), 'wait-snapshot.json');
}

// The adapter reports the sessions this test chooses.
function stubList(t, list) {
  const original = fake.list;
  fake.list = async () => list();
  t.after(() => {
    fake.list = original;
  });
}

// A started task whose real crew process is already gone, so only the stubbed list counts.
async function startedTaskWithoutCrew() {
  const record = await startTask('demo', { id: 'a' });
  const crew = listSessions('demo').find((session) => session.shortId === record.session);
  await fake.stop(crew);
  await waitFor(() => sessionEnded(crew), 30000, 'the crew process to end');
  return crew;
}

function secondsAgo(seconds) {
  return new Date(Date.now() - seconds * 1000).toISOString();
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
  await waitFor(() => fs.existsSync(resultFile('a')), 30000, 'the task result');
  const crew = listSessions('demo').find((session) => session.shortId === record.session);
  await waitFor(() => sessionEnded(crew), 30000, 'the crew session to end');

  const startedAt = Date.now();
  const changes = await wait(5);
  assert.ok(Date.now() - startedAt < 1000, 'the change was already there');
  assert.deepStrictEqual(changes, [
    { kind: 'task', id: 'a', from: 'running', to: 'done' },
  ]);

  // Reported once: on timeout, wait prints no change and still succeeds.
  assert.deepStrictEqual(await wait(0), []);
});

test('a finished task wakes the lead once', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  const record = await startTask('demo', { id: 'a' });
  await wait(5);

  // The fake crew member runs `task done a` after 1 s, then its session ends.
  const changes = await wait(5);
  const crew = listSessions('demo').find((session) => session.shortId === record.session);
  await waitFor(() => sessionEnded(crew), 30000, 'the crew session to end');

  assert.deepStrictEqual(changes, [{ kind: 'task', id: 'a', from: 'running', to: 'done' }]);
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
  await waitFor(() => sessionEnded(crew), 30000, 'the crew session to end');

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

test('a wait running when the mission is stopped returns without changing anything', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  await startTask('demo', { id: 'a' });
  await wait(5);
  const taskBefore = fs.readFileSync(path.join(missionDir('demo'), 'tasks', 'a.json'), 'utf8');
  const snapshotBefore = fs.readFileSync(snapshotFile(), 'utf8');

  const io = makeIo({ env: { RELAYLEAD_MISSION: 'demo' } });
  const waiting = run(['wait', '--timeout', '5'], io);
  await stopMission('demo'); // kills the crew: no result will ever come
  const startedAt = Date.now();
  assert.strictEqual(await waiting, 1);
  assert.ok(Date.now() - startedAt < 1000, 'wait must return as soon as the mission is stopped');
  assert.match(io.err.text, /stopped/);

  assert.strictEqual(fs.readFileSync(path.join(missionDir('demo'), 'tasks', 'a.json'), 'utf8'), taskBefore);
  assert.strictEqual(fs.readFileSync(snapshotFile(), 'utf8'), snapshotBefore);
  await assert.rejects(startTask('demo', { id: 'b' }), { code: 'mission-stopped' });
});

test('changes not printed are reported again', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);

  const report = () => {
    throw new Error('output closed');
  };
  await assert.rejects(waitForChanges('demo', 5, report), /output closed/);
  assert.strictEqual(fs.existsSync(snapshotFile()), false);

  let printed;
  await waitForChanges('demo', 5, (changes) => (printed = changes));
  assert.deepStrictEqual(printed, [
    { kind: 'task', id: 'a', from: null, to: 'todo' },
    { kind: 'task', id: 'b', from: null, to: 'todo' },
  ]);
});

test('a working session without a process gets 60 s before its task fails', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  const crew = await startedTaskWithoutCrew();
  stubList(t, () => [{ ...crew, state: 'working', pid: null }]);

  writeJson(snapshotFile(), { lostSince: { [crew.shortId]: secondsAgo(1) } });
  await wait(0);
  assert.strictEqual(listTasks('demo')[0].state, 'running');

  writeJson(snapshotFile(), { lostSince: { [crew.shortId]: secondsAgo(61) } });
  await wait(0);
  assert.strictEqual(listTasks('demo')[0].state, 'failed');
});

test('a session missing from the adapter list gets the same grace', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  const crew = await startedTaskWithoutCrew();
  stubList(t, () => []);

  await wait(0);
  assert.strictEqual(listTasks('demo')[0].state, 'running');

  writeJson(snapshotFile(), { lostSince: { [crew.shortId]: secondsAgo(61) } });
  await wait(0);
  assert.strictEqual(listTasks('demo')[0].state, 'failed');
});

test('a crew session waiting without a result gets 60 s, then its task fails and it is stopped', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  const crew = await startedTaskWithoutCrew();
  // A Claude session "blocked": its turn ended with a question nobody answers, or it is rate-limited.
  stubList(t, () => [{ ...crew, state: 'waiting' }]);
  const originalStop = fake.stop;
  const stopped = [];
  fake.stop = async (session) => {
    stopped.push(session.shortId);
  };
  t.after(() => {
    fake.stop = originalStop;
  });

  writeJson(snapshotFile(), { lostSince: { [crew.shortId]: secondsAgo(1) } });
  await wait(0);
  assert.strictEqual(listTasks('demo')[0].state, 'running');
  assert.deepStrictEqual(stopped, []);

  writeJson(snapshotFile(), { lostSince: { [crew.shortId]: secondsAgo(61) } });
  await wait(0);
  assert.strictEqual(listTasks('demo')[0].state, 'failed');
  assert.deepStrictEqual(stopped, [crew.shortId]);
});

test('wait reads the task files often but asks the adapter at most every 2.5 s', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  await wait(0); // the first wait reports everything: from now on nothing changes
  const original = fake.list;
  let listCalls = 0;
  fake.list = async (mission) => {
    listCalls++;
    return original(mission);
  };
  t.after(() => {
    fake.list = original;
  });

  assert.deepStrictEqual(await wait(3), []);
  assert.ok(listCalls >= 1 && listCalls <= 2, `${listCalls} calls to list in 3 s`);
});

test('a wait left running by a replaced lead stops without touching anything', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  const nameLead = (session) =>
    writeJson(path.join(missionDir('demo'), 'lead.json'), { shortId: 'aaaa1111', sessionName: session, startedAt: new Date().toISOString() });
  nameLead('demo/lead/1');
  const env = { RELAYLEAD_MISSION: 'demo', RELAYLEAD_ROLE: 'lead', RELAYLEAD_SESSION: 'demo/lead/1' };
  assert.strictEqual(await run(['wait', '--timeout', '0'], makeIo({ env })), 0);
  const before = fs.readFileSync(snapshotFile(), 'utf8');
  const stamp = fs.statSync(snapshotFile()).mtimeMs;

  const io = makeIo({ env });
  const waiting = run(['wait', '--timeout', '5'], io);
  await new Promise((resolve) => setTimeout(resolve, 300));
  // Replaced, and something changes: the wait must not report it.
  nameLead('demo/lead/2');
  const replacedAt = Date.now();
  fs.writeFileSync(path.join(dir, 'tasks', 'c.md'), '---\ntitle: Third task\n---\n\nWrite the third file.\n');

  assert.strictEqual(await waiting, 1);
  assert.ok(Date.now() - replacedAt < 2000, 'the wait must end within 2 s');
  assert.match(io.err.text, /no longer the lead of mission "demo": demo\/lead\/2 took over/);
  assert.strictEqual(fs.readFileSync(snapshotFile(), 'utf8'), before);
  assert.strictEqual(fs.statSync(snapshotFile()).mtimeMs, stamp);
});
