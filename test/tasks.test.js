const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run } = require('../core/cli');
const { listTasks, startTask, finishTask, deliverTask } = require('../core/tasks');
const { getState, setState, stopMission } = require('../core/missions');
const { withMissionLock } = require('../core/mission-lock');
const { sleep } = require('../core/timing');
const { askQuestion, answerQuestion } = require('../core/questions');
const { writeJson } = require('../core/store');
const { loadProfile } = require('../core/profiles');
const { listSessions, isAlive } = require('../core/sessions');
const { readJson } = require('../core/store');
const { missionDir } = require('../core/paths');
const fake = require('../adapters/fake');
const { makeIo, waitFor } = require('../fixtures/helpers');
const { setupProject, writeMission, missionReport } = require('../fixtures/missions');

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
  assert.deepStrictEqual(spec.profile, loadProfile('developer', { dir }));
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

test('a task with an unknown profile is refused before anything is launched', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  const specs = spyLaunches(t);

  await assert.rejects(startTask('demo', { id: 'a', profile: 'ghost' }), { code: 'unknown-profile' });

  assert.strictEqual(specs.length, 0);
  assert.strictEqual(fs.existsSync(path.join(missionDir('demo'), 'tasks', 'a.json')), false);
  assert.strictEqual(fs.existsSync(path.join(dir, 'out', 'a')), false);
});

test('a task that asks first starts once answered, and its crew member gets the answer', async (t) => {
  const dir = setupProject(t, 'demo');
  fs.writeFileSync(path.join(dir, 'tasks', 'c.md'), '---\ntitle: Theme\nask: Blue or green theme?\n---\n\nAdd the theme.\n');
  writeMission('demo', dir);
  const specs = spyLaunches(t);

  await assert.rejects(startTask('demo', { id: 'c' }), { code: 'task-not-answered' });
  askQuestion('demo', { key: 'c', text: 'Blue or green theme?', options: ['Blue', 'Green', 'Skip this task'] });
  await assert.rejects(startTask('demo', { id: 'c' }), { code: 'task-not-answered' });
  assert.strictEqual(specs.length, 0);

  answerQuestion('demo', 'q-c', 'Green');
  await startTask('demo', { id: 'c' });
  assert.ok(specs[0].prompt.includes('Question asked before this task: Blue or green theme?'), specs[0].prompt);
  assert.ok(specs[0].prompt.includes('Answer from the user: Green'), specs[0].prompt);
});

test('a task whose dependencies are not delivered is refused, naming them', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  const specs = spyLaunches(t);
  await startTask('demo', { id: 'a' });

  // a is running, then done: neither is delivered.
  await assert.rejects(startTask('demo', { id: 'b' }), { code: 'task-not-ready', vars: { id: 'b', missing: 'a' } });
  finishTask('demo', 'a', { state: 'done' });
  await assert.rejects(startTask('demo', { id: 'b' }), { code: 'task-not-ready' });

  assert.strictEqual(specs.length, 1);
  assert.strictEqual(fs.existsSync(path.join(missionDir('demo'), 'tasks', 'b.json')), false);
  assert.strictEqual(fs.existsSync(path.join(dir, 'out', 'b')), false);
});

test('a task the user chose to skip is refused', async (t) => {
  const dir = setupProject(t, 'demo');
  fs.writeFileSync(path.join(dir, 'tasks', 'c.md'), '---\ntitle: Theme\nask: Add a theme?\n---\n\nAdd the theme.\n');
  writeMission('demo', dir);
  const specs = spyLaunches(t);
  askQuestion('demo', { key: 'c', text: 'Add a theme?', options: ['Yes, do it', 'Skip this task'] });
  answerQuestion('demo', 'q-c', '2');

  await assert.rejects(startTask('demo', { id: 'c' }), { code: 'task-skipped', vars: { id: 'c' } });
  assert.strictEqual(specs.length, 0);
});

test('no task starts once the mission is done', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  writeJson(path.join(missionDir('demo'), 'state.json'), { state: 'done' });
  const specs = spyLaunches(t);

  await assert.rejects(startTask('demo', { id: 'a' }), { code: 'mission-done' });
  assert.strictEqual(specs.length, 0);
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

// A third task, c, that depends on nothing: a and c can start together.
function addIndependentTask(dir) {
  fs.writeFileSync(path.join(dir, 'tasks', 'c.md'), '---\ntitle: Third task\n---\n\nWrite the third file.\n');
}

test('concurrent starts of two tasks give distinct session names', async (t) => {
  const dir = setupProject(t, 'demo');
  addIndependentTask(dir);
  writeMission('demo', dir);

  await Promise.all([startTask('demo', { id: 'a' }), startTask('demo', { id: 'c' })]);

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
  const refused = assert.rejects(starting, { code: 'mission-stopped' }); // the stop waits for the start
  await stopMission('demo'); // the crew member is not in the registry yet

  await refused;
  await waitFor(() => !isAlive(crew.pid), 30000, 'the crew member to be stopped');
  assert.strictEqual(fs.existsSync(path.join(missionDir('demo'), 'tasks', 'a.json')), false);
});

function startLock() {
  return path.join(missionDir('demo'), 'start.lock');
}

test('a start lock left by a dead process is taken over', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  addIndependentTask(dir);
  fs.writeFileSync(startLock(), String(spawnSync(process.execPath, ['-e', '']).pid));

  await Promise.all([startTask('demo', { id: 'a' }), startTask('demo', { id: 'c' })]);

  assert.deepStrictEqual(
    listSessions('demo').map((session) => session.name).sort(),
    ['demo/developer/1', 'demo/developer/2'],
  );
  assert.strictEqual(fs.existsSync(startLock()), false);
});

test('the start lock names its holder', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  const original = fake.launch;
  let lock = null;
  fake.launch = async (spec) => {
    lock = JSON.parse(fs.readFileSync(startLock(), 'utf8'));
    return original(spec);
  };
  t.after(() => {
    fake.launch = original;
  });

  const before = Date.now();
  await startTask('demo', { id: 'a' });

  assert.deepStrictEqual([lock.pid, lock.command], [process.pid, 'task start a']);
  assert.ok(Date.parse(lock.since) >= before - 1000, lock.since);
});

// Its holder is alive (this very process) but has held it for 16 minutes: it is stuck.
test('a start lock held for too long is reported at once, with its holder', { timeout: 5000 }, async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  const since = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  fs.writeFileSync(startLock(), JSON.stringify({ pid: process.pid, command: 'task deliver a', since }));

  await assert.rejects(startTask('demo', { id: 'a' }), {
    code: 'start-stuck',
    vars: { mission: 'demo', command: 'task deliver a', pid: process.pid, since },
  });
  assert.strictEqual(fs.existsSync(path.join(missionDir('demo'), 'tasks', 'a.json')), false);
});

// 11 minutes is not stuck: a delivery may run several git commands of up to 5 minutes each.
test('a start that waits too long names the holder of the lock', { timeout: 5000 }, async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  const since = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  fs.writeFileSync(startLock(), JSON.stringify({ pid: process.pid, command: 'task deliver a', since }));
  // A clock that runs a second per reading: the minute a start waits passes at once.
  const startedAt = Date.now();
  let readings = 0;
  t.mock.method(Date, 'now', () => startedAt + readings++ * 1000);

  await assert.rejects(startTask('demo', { id: 'a' }), {
    code: 'start-busy',
    vars: { mission: 'demo', command: 'task deliver a', pid: process.pid, since },
  });
});

// Like Windows refusing to create the file again for a while (EPERM) after its holder removed it.
test('a start gives up after a minute even when the lock cannot be read', { timeout: 5000 }, async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  const originalWrite = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, ...rest) => {
    if (String(file).endsWith('start.lock')) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    return originalWrite(file, ...rest);
  });
  const startedAt = Date.now();
  let readings = 0;
  t.mock.method(Date, 'now', () => startedAt + readings++ * 1000);

  await assert.rejects(startTask('demo', { id: 'a' }), {
    code: 'start-busy',
    vars: { mission: 'demo', command: '?', pid: '?', since: '?' },
  });
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
  for (const id of ['my task', '_integration', '-a', '.a', 'a..b', 'a.lock', 'a.']) {
    const dir = setupProject(t, 'demo');
    writeMission('demo', dir);
    fs.writeFileSync(path.join(dir, 'tasks', `${id}.md`), '---\ntitle: Bad\n---\n');
    assert.throws(() => listTasks('demo'), { code: 'bad-task-id' }, id);
    await assert.rejects(startTask('demo', { id: 'a' }), { code: 'bad-task-id' }, id);
  }
});

test('fake mission runs two dependent tasks to done', async (t) => {
  const dir = setupProject(t, 'demo');

  const io = makeIo();
  assert.strictEqual(await run(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir], io), 0, io.err.text);
  await waitFor(() => getState('demo') === 'done', 45000, 'the mission to be done', () => missionReport('demo'));

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

// The lock is held until `release` is called: resolves once it is held.
function holdMissionLock(name, command) {
  let release;
  const held = new Promise((resolve) => {
    const finished = withMissionLock(name, command, () => new Promise((done) => (release = done)));
    finished.catch(() => {});
    resolve(finished);
  });
  return { finished: held, release: () => release() };
}

test('the end of state set done holds the mission lock', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  await startTask('demo', { id: 'a' });
  const original = fake.stop;
  let stopping = false;
  fake.stop = async (session) => {
    stopping = true;
    await sleep(500);
    return original(session);
  };
  t.after(() => {
    fake.stop = original;
  });

  const ending = setState('demo', 'done').then(() => Date.now());
  await waitFor(() => stopping, 10000, 'the crew to be stopping');
  let probe = null;
  const probing = withMissionLock('demo', 'probe', async () => {
    probe = { at: Date.now(), reaper: fs.existsSync(path.join(missionDir('demo'), 'reaper.json')) };
  });
  const endedAt = await ending;
  await probing;

  assert.ok(probe.at >= endedAt, 'the probe must run after state set done is over');
  assert.strictEqual(probe.reaper, true);
});

test('a stop waits for the holder of the mission lock', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  await startTask('demo', { id: 'a' });
  const original = fake.stop;
  let stoppedAt = null;
  fake.stop = async (session) => {
    stoppedAt = stoppedAt || Date.now();
    return original(session);
  };
  t.after(() => {
    fake.stop = original;
  });

  let stopping;
  let releasedAt = null;
  await withMissionLock('demo', 'probe', async () => {
    stopping = stopMission('demo');
    await waitFor(() => getState('demo') === 'stopped', 10000, 'the state to be stopped');
    await sleep(500);
    assert.strictEqual(stoppedAt, null, 'no session may be stopped while the lock is held');
    releasedAt = Date.now();
  });
  await stopping;

  assert.ok(stoppedAt >= releasedAt, 'the sessions must be stopped after the lock is released');
});

test('the mission lock of an unknown mission is a coded error', async (t) => {
  setupProject(t, 'demo');
  await assert.rejects(withMissionLock('ghost', 'probe', async () => {}), { code: 'mission-unknown' });
});

test('a stop that gives up behind a slow holder says to run it again', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  const previous = process.env.RELAYLEAD_START_LOCK_WAIT_MS;
  process.env.RELAYLEAD_START_LOCK_WAIT_MS = '300';
  t.after(() => {
    if (previous === undefined) delete process.env.RELAYLEAD_START_LOCK_WAIT_MS;
    else process.env.RELAYLEAD_START_LOCK_WAIT_MS = previous;
  });
  const holder = holdMissionLock('demo', 'task deliver a');
  await waitFor(() => fs.existsSync(startLock()), 10000, 'the lock to be held');

  const io = makeIo();
  const code = await run(['stop', 'demo'], io);
  holder.release();
  await holder.finished;

  assert.strictEqual(code, 1);
  assert.match(io.err.text, /run relaylead stop demo again/);
  assert.match(io.err.text, /task deliver a/);
  assert.strictEqual(getState('demo'), 'stopped');
});
