const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const watcher = require('../core/watcher');
const { run } = require('../core/cli');
const { t: msg } = require('../core/messages');
const { home, missionDir } = require('../core/paths');
const { writeJson, readJson } = require('../core/store');
const { recordSession, listSessions } = require('../core/sessions');
const { startTask, listTasks } = require('../core/tasks');
const { sendMail } = require('../core/mailbox');
const { askQuestion: ask, listQuestions } = require('../core/questions');
const fake = require('../adapters/fake');
const { tmpDir, makeIo, waitFor, sessionEnded, userEnv } = require('../fixtures/helpers');
const { freshHome, setupProject, writeMission, missionReport } = require('../fixtures/missions');

// A pid no process has: a dead holder, or the process of a session listed by a stubbed agent.
const DEAD_PID = 2147483646;
const BIN = path.join(__dirname, '..', 'bin', 'relaylead.js');

function lockFile() {
  return path.join(home(), 'watcher.lock');
}

function logFile() {
  return path.join(home(), 'watcher.log');
}

function logText() {
  try {
    return fs.readFileSync(logFile(), 'utf8');
  } catch {
    return '';
  }
}

async function watcherRun(...args) {
  const io = makeIo();
  const code = await run(['watcher', 'run', ...args], io);
  return { code, out: io.out.text, err: io.err.text };
}

function writeLead(mission, session) {
  writeJson(path.join(missionDir(mission), 'lead.json'), {
    sessionId: session.sessionId,
    shortId: session.shortId,
    sessionName: session.name,
    startedAt: new Date().toISOString(),
  });
}

// A registry record of a session that no agent runs: only the stubbed list below shows it.
function record(mission, name, role) {
  const hex = crypto.randomBytes(8).toString('hex');
  const session = { sessionId: `fake-${hex}`, shortId: hex.slice(0, 8), name, role, pid: DEAD_PID, cwd: tmpDir('relaylead-cwd-') };
  recordSession(mission, session);
  return session;
}

// Mission `name` (mission.json, a project without tasks), its lead and an extra lead in the registry.
function missionWithExtraLead(name, { lead = true } = {}) {
  const dir = tmpDir('relaylead-project-');
  fs.mkdirSync(path.join(dir, 'tasks'));
  writeMission(name, dir);
  const current = record(name, `${name}/lead/1`, 'lead');
  const extra = record(name, `${name}/lead/9`, 'lead');
  if (lead) writeLead(name, current);
  return { current, extra };
}

// The agent lists every recorded session working with a process, until it is stopped; the stops
// are kept in `stops` (short ids).
function stubAgent(t) {
  const { list, stop } = fake;
  const stops = [];
  fake.list = async (mission) =>
    listSessions(mission).map((session) =>
      stops.includes(session.shortId)
        ? { ...session, state: 'done', pid: null, idle: true }
        : { ...session, state: 'working', pid: DEAD_PID, idle: false },
    );
  fake.stop = async (session) => {
    stops.push(session.shortId);
  };
  t.after(() => {
    fake.list = list;
    fake.stop = stop;
  });
  return stops;
}

// A session of the fake agent for mission demo that ends its first turn and stays alive: listed
// done and idle with its process, as Claude lists a lead that has finished its turn.
async function launchIdleLead(dir, name) {
  const session = await fake.launch({
    mission: 'demo',
    name,
    role: 'lead',
    profile: null,
    prompt: '',
    cwd: dir,
    env: { RELAYLEAD_MISSION: 'demo', RELAYLEAD_HOME: home(), RELAYLEAD_FAKE_END_FIRST_TURN: '1' },
    permissionMode: 'allowlist',
  });
  recordSession('demo', session);
  await waitFor(() => fs.existsSync(session.idleFile), 30000, `${name} to end its turn`, () => missionReport('demo'));
  return session;
}

// Mission demo with its lead and an extra lead, both run by the fake agent. The lead waits, and its
// last wait has seen both tasks: nothing wakes it.
async function demoWithTwoLeads(t) {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  writeJson(path.join(missionDir('demo'), 'state.json'), { state: 'waiting' });
  writeJson(path.join(missionDir('demo'), 'wait-snapshot.json'), { tasks: { a: 'todo', b: 'todo' }, questions: {}, lostSince: {} });
  const current = await launchIdleLead(dir, 'demo/lead/1');
  const extra = await launchIdleLead(dir, 'demo/lead/9');
  writeLead('demo', current);
  return { current, extra };
}

async function listed(session) {
  return (await fake.list('demo')).find((row) => row.shortId === session.shortId);
}

test('watcher run does nothing while STOP is present', async (t) => {
  const { extra } = await demoWithTwoLeads(t);
  fs.writeFileSync(path.join(home(), 'STOP'), '');

  for (const args of [[], ['--mission', 'demo']]) {
    const { code, out } = await watcherRun(...args);
    assert.strictEqual(code, 0);
    assert.strictEqual(out, msg('watcherStopPresent', { home: home() }));
  }
  assert.strictEqual(sessionEnded(extra), false);
  assert.ok((await listed(extra)).pid, 'the extra lead still has its process');
  assert.strictEqual(logText(), '');
  assert.strictEqual(fs.existsSync(path.join(missionDir('demo'), 'watch.json')), false);
});

test('a pass stops an extra lead and logs it', async (t) => {
  const { current, extra } = await demoWithTwoLeads(t);

  const { code, out, err } = await watcherRun();
  assert.strictEqual(code, 0, err);
  assert.strictEqual(sessionEnded(extra), true, missionReport('demo'));
  assert.strictEqual(sessionEnded(current), false);
  assert.match(logText(), new RegExp(`^\\S+ demo stop-extra-lead ${extra.shortId}\\n$`));
  assert.strictEqual(out, logText());

  // Nothing more to do: the next pass writes nothing.
  assert.strictEqual((await watcherRun()).out, '');
  assert.match(logText(), /^\S+ demo stop-extra-lead \S+\n$/);
});

test('STOP written during a pass stops it before the next action and the next mission', async (t) => {
  freshHome(t);
  const stops = stubAgent(t);
  missionWithExtraLead('first');
  missionWithExtraLead('second');
  const { observe } = watcher;
  watcher.observe = async (name) => {
    const obs = await observe(name);
    fs.writeFileSync(path.join(home(), 'STOP'), ''); // the user writes STOP during the first observation
    return obs;
  };
  t.after(() => {
    watcher.observe = observe;
  });

  const { code, out } = await watcherRun();
  assert.strictEqual(code, 0);
  assert.strictEqual(out, msg('watcherStopPresent', { home: home() }));
  assert.deepStrictEqual(stops, []);
  assert.strictEqual(logText(), '');
});

test('a detail on several lines is logged on one', async (t) => {
  freshHome(t);
  stubAgent(t);
  missionWithExtraLead('demo');
  fake.list = async () => {
    throw new Error('claude agents failed:\n  some output\n');
  };
  await watcher.runPass();
  assert.match(logText(), /^\S+ demo list-failed claude agents failed: some output\n$/);
});

test('a pass keeps what it saw of the lead in watch.json', async (t) => {
  freshHome(t);
  const { current } = missionWithExtraLead('demo');
  const { list } = fake;
  fake.list = async () => []; // the agent lists no session: the lead may be restarting
  t.after(() => {
    fake.list = list;
  });

  await watcher.runPass();
  const watch = readJson(path.join(missionDir('demo'), 'watch.json'));
  assert.ok(Date.parse(watch.leadLostSince) <= Date.now());
  assert.match(logText(), new RegExp(`^\\S+ demo lead-restarting ${current.shortId}\\n$`));

  // Seen lost already: nothing new to log or keep.
  await watcher.runPass();
  assert.deepStrictEqual(readJson(path.join(missionDir('demo'), 'watch.json')), watch);
  assert.strictEqual(logText().split('\n').length, 2);
});

test('a pass skips finished, stopping and launching missions', async (t) => {
  freshHome(t);
  const stops = stubAgent(t);
  missionWithExtraLead('ended');
  writeJson(path.join(missionDir('ended'), 'state.json'), { state: 'done' });
  missionWithExtraLead('halted');
  writeJson(path.join(missionDir('halted'), 'state.json'), { state: 'stopped' });
  missionWithExtraLead('stopping');
  writeJson(path.join(missionDir('stopping'), 'state.json'), { state: 'stopped', stopping: true });
  missionWithExtraLead('launching', { lead: false });
  // A folder whose launch has not written mission.json yet.
  fs.mkdirSync(missionDir('reserved'));

  // The launching mission is still to be watched.
  assert.deepStrictEqual(await watcher.runPass(), { outcome: 'done', missions: 1 });
  assert.deepStrictEqual(stops, []);
  assert.strictEqual(logText(), '');
  for (const name of ['ended', 'halted', 'stopping', 'launching', 'reserved']) {
    assert.strictEqual(await watcher.observe(name), null, name);
    assert.strictEqual(fs.existsSync(path.join(missionDir(name), 'watch.json')), false, name);
  }
});

test('a held pass lock is reported and nothing is done', async (t) => {
  freshHome(t);
  const stops = stubAgent(t);
  missionWithExtraLead('demo');
  const holder = { pid: process.pid, since: new Date().toISOString() };
  writeJson(lockFile(), holder);

  const { code, out } = await watcherRun();
  assert.strictEqual(code, 0);
  assert.strictEqual(out, msg('watcherBusy', holder));
  assert.deepStrictEqual(stops, []);
  assert.deepStrictEqual(readJson(lockFile()), holder);
});

test('a pass lock of a dead process or older than 15 min is taken over', async (t) => {
  freshHome(t);
  const stops = stubAgent(t);
  const { extra } = missionWithExtraLead('demo');
  const stale = [
    { pid: DEAD_PID, since: new Date().toISOString() },
    { pid: process.pid, since: new Date(Date.now() - 16 * 60 * 1000).toISOString() },
  ];
  for (const holder of stale) {
    writeJson(lockFile(), holder);
    stops.length = 0;
    fs.rmSync(path.join(missionDir('demo'), 'watch.json'), { force: true });
    // The stub lists the extra lead again once its stop is forgotten.
    assert.deepStrictEqual(await watcher.runPass(), { outcome: 'done', missions: 1 }, JSON.stringify(holder));
    assert.deepStrictEqual(stops, [extra.shortId]);
    assert.strictEqual(fs.existsSync(lockFile()), false, 'the pass removed its own lock');
  }
});

test('a pass does not remove the lock of the pass that took it over', async (t) => {
  freshHome(t);
  stubAgent(t);
  missionWithExtraLead('demo');
  const other = { pid: process.pid, since: '2026-11-20T09:00:00.000Z' };
  const { observe } = watcher;
  watcher.observe = async () => {
    writeJson(lockFile(), other); // another pass took the lock over meanwhile
    return null;
  };
  t.after(() => {
    watcher.observe = observe;
  });

  assert.strictEqual((await watcher.runPass()).outcome, 'done');
  assert.deepStrictEqual(readJson(lockFile()), other);
});

test('watcher.log moves to watcher.log.1 past 1 MiB', async (t) => {
  freshHome(t);
  fs.writeFileSync(logFile(), 'x'.repeat(1048575) + '\n');
  await watcher.runPass();
  assert.strictEqual(fs.statSync(logFile()).size, 1048576, 'not past 1 MiB yet');
  assert.strictEqual(fs.existsSync(logFile() + '.1'), false);

  fs.appendFileSync(logFile(), 'y\n');
  fs.writeFileSync(logFile() + '.1', 'older\n');
  await watcher.runPass();
  assert.strictEqual(fs.existsSync(logFile()), false);
  assert.strictEqual(fs.statSync(logFile() + '.1').size, 1048578);
});

test('a mission that cannot be read does not hide the next ones', async (t) => {
  freshHome(t);
  const stops = stubAgent(t);
  fs.mkdirSync(missionDir('bad'), { recursive: true });
  fs.writeFileSync(path.join(missionDir('bad'), 'mission.json'), '{');
  const { extra } = missionWithExtraLead('good');

  let result;
  try {
    result = await watcherRun();
  } finally {
    // The cleanup of freshHome lists the missions, which fails on an unreadable one.
    fs.rmSync(missionDir('bad'), { recursive: true, force: true });
  }
  const { code, out } = result;
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(stops, [extra.shortId]);
  const lines = logText().trim().split('\n');
  assert.match(lines[0], /^\S+ bad error observe bad: invalid JSON/);
  assert.match(lines[1], new RegExp(`^\\S+ good stop-extra-lead ${extra.shortId}$`));
  assert.strictEqual(out, logText());
});

test('a pass for a mission removed or replaced meanwhile does nothing', async (t) => {
  freshHome(t);
  const stops = stubAgent(t);
  missionWithExtraLead('demo');
  const seen = await watcher.observe('demo');
  assert.ok(seen.rows.length === 2);
  const { observe } = watcher;
  t.after(() => {
    watcher.observe = observe;
  });

  // Replaced: the observation is of an older mission of the same name.
  watcher.observe = async () => ({ ...seen, mission: { ...seen.mission, createdAt: '2026-01-01T00:00:00.000Z' } });
  assert.deepStrictEqual(await watcher.tendMission('demo'), []);
  assert.deepStrictEqual(stops, []);
  assert.strictEqual(fs.existsSync(path.join(missionDir('demo'), 'watch.json')), false);

  // Removed: its folder is not made again.
  watcher.observe = async () => seen;
  fs.rmSync(missionDir('demo'), { recursive: true, force: true });
  assert.deepStrictEqual(await watcher.tendMission('demo'), []);
  assert.deepStrictEqual(stops, []);
  assert.strictEqual(fs.existsSync(missionDir('demo')), false);
  assert.strictEqual(logText(), '');
});

test('the lead is read idle only on two idle reads', async (t) => {
  freshHome(t);
  const { current } = missionWithExtraLead('demo');
  const previous = process.env.RELAYLEAD_IDLE_RECHECK_MS;
  process.env.RELAYLEAD_IDLE_RECHECK_MS = '20';
  const { list } = fake;
  t.after(() => {
    fake.list = list;
    if (previous === undefined) delete process.env.RELAYLEAD_IDLE_RECHECK_MS;
    else process.env.RELAYLEAD_IDLE_RECHECK_MS = previous;
  });
  // The lead row of each read, in turn.
  const observeWith = async (...leadRows) => {
    let calls = 0;
    fake.list = async () => [{ ...current, ...leadRows[Math.min(calls++, leadRows.length - 1)] }];
    const obs = await watcher.observe('demo');
    return { obs, calls };
  };

  const idle = { state: 'working', pid: DEAD_PID, idle: true };
  const busy = { state: 'working', pid: DEAD_PID, idle: false };
  const once = await observeWith(idle, busy);
  assert.strictEqual(once.obs.leadIdleConfirmed, false);
  assert.strictEqual(once.calls, 2);
  assert.strictEqual(once.obs.rows[0].idle, false, 'the second read is the one kept');

  const twice = await observeWith(idle, idle);
  assert.strictEqual(twice.obs.leadIdleConfirmed, true);

  // Busy, or done with its process: read once.
  for (const leadRow of [busy, { state: 'done', pid: DEAD_PID, idle: true }]) {
    const single = await observeWith(leadRow);
    assert.strictEqual(single.calls, 1);
    assert.strictEqual(single.obs.leadIdleConfirmed, false);
  }

  // A list that fails is no observation of the sessions.
  fake.list = async () => {
    throw new Error('claude agents timed out');
  };
  const failed = await watcher.observe('demo');
  assert.strictEqual(failed.rows, null);
  assert.strictEqual(failed.listError, 'claude agents timed out');
});

test('watcher run is refused in a session and needs a known mission', async () => {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  const inSession = makeIo({ env: { RELAYLEAD_MISSION: 'demo' } });
  assert.strictEqual(await run(['watcher', 'run'], inSession), 1);
  assert.strictEqual(inSession.err.text, `relaylead watcher: ${msg('not-from-a-session', { command: 'watcher' })}\n`);

  const { code, err } = await watcherRun('--mission', 'ghost');
  assert.strictEqual(code, 1);
  assert.strictEqual(err, `relaylead watcher: ${msg('mission-unknown', { mission: 'ghost' })}\n`);

  for (const args of [['now'], ['--mission=']]) {
    const usage = await watcherRun(...args);
    assert.strictEqual(usage.code, 1, args.join(' '));
    assert.match(usage.err, /usage: relaylead watcher run \[--mission <name>\]/);
  }
});

function stateFile(mission) {
  return path.join(missionDir(mission), 'state.json');
}

function watchFile(mission) {
  return path.join(missionDir(mission), 'watch.json');
}

// The modification time of every file of the mission folder, and of watcher.log.
function stamps(mission) {
  const found = {};
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else found[file] = fs.statSync(file).mtimeMs;
    }
  };
  walk(missionDir(mission));
  found[logFile()] = fs.statSync(logFile()).mtimeMs;
  return found;
}

// `relaylead watcher run --mission demo` in a process of its own, as a targeted pass runs.
function targetedPass() {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [BIN, 'watcher', 'run', '--mission', 'demo'],
      { env: { ...userEnv(), RELAYLEAD_HOME: home() }, windowsHide: true, timeout: 60000 },
      (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)),
    );
  });
}

function leadLog(session) {
  try {
    return fs.readFileSync(session.logFile, 'utf8');
  } catch {
    return '';
  }
}

test('observe writes nothing', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  writeLead('demo', record('demo', 'demo/lead/1', 'lead'));
  writeJson(stateFile('demo'), { state: 'waiting' });
  // A crew lost for longer than the grace of wait: its task is to fail, by act alone.
  const task = await startTask('demo', { id: 'a' });
  const crew = listSessions('demo').find((session) => session.shortId === task.session);
  await fake.stop(crew);
  await waitFor(() => sessionEnded(crew), 30000, 'the crew session to end');
  writeJson(watchFile('demo'), { crewLostSince: { [crew.shortId]: new Date(Date.now() - 61 * 1000).toISOString() } });
  fs.writeFileSync(logFile(), '');
  const before = stamps('demo');

  const obs = await watcher.observe('demo');
  assert.deepStrictEqual(obs.unseen.toFail, [{ id: 'a', shortId: crew.shortId, summary: 'crew session ended without a result' }]);
  assert.strictEqual(obs.mail[crew.shortId], 0);
  const { list } = fake;
  fake.list = async () => {
    throw new Error('claude agents timed out');
  };
  t.after(() => {
    fake.list = list;
  });
  const failed = await watcher.observe('demo');
  assert.strictEqual(failed.listError, 'claude agents timed out');
  assert.strictEqual(failed.unseen, null);

  assert.deepStrictEqual(stamps('demo'), before);
  assert.strictEqual(listTasks('demo')[0].state, 'running');
});

test('two targeted passes at once wake the lead once', async (t) => {
  const dir = setupProject(t, 'demo');
  fs.writeFileSync(path.join(dir, 'tasks', 'c.md'), '---\ntitle: Third task\n---\n\nWrite the third file.\n');
  writeMission('demo', dir);
  writeJson(stateFile('demo'), { state: 'waiting', updatedAt: new Date().toISOString() });
  const lead = await launchIdleLead(dir, 'demo/lead/1');
  writeLead('demo', lead);
  // The test plays the lead: it starts a and c, whose crew members finish them.
  for (const id of ['a', 'c']) await startTask('demo', { id });
  const crew = listSessions('demo').filter((session) => session.role === 'crew');
  await waitFor(
    () => crew.every(sessionEnded) && listTasks('demo').filter((task) => task.state === 'done').length === 2,
    30000,
    'a and c to be done',
    () => missionReport('demo'),
  );

  await Promise.all([targetedPass(), targetedPass()]);
  await waitFor(() => leadLog(lead).includes('woken:'), 30000, 'the lead to be woken', () => missionReport('demo'));
  const woken = leadLog(lead).split('\n').filter((line) => line.includes('woken:'));
  assert.strictEqual(woken.length, 1, missionReport('demo'));
  assert.match(woken[0], /woken: Relaylead woke you: task a is now done; task b is now todo; task c is now done\. Carry on/);
  const wakeLines = logText().split('\n').filter((line) => / demo wake-lead /.test(line));
  assert.strictEqual(wakeLines.length, 1, logText());
  // The second pass found the lead woken already.
  const watch = readJson(watchFile('demo'));
  assert.ok(Date.parse(watch.lastLeadActionAt) <= Date.now());
  // Still waiting for its judgement, or cleared by the woken lead's heartbeat.
  assert.ok([watch.lastLeadActionAt, null].includes(watch.lastWakeAt), JSON.stringify(watch));
  assert.ok(watch.lastWakeView);
  assert.strictEqual(watch.ineffectiveWakes, 0);
});

test('a wake that throws counts as a wake without effect', async (t) => {
  freshHome(t);
  const dir = tmpDir('relaylead-project-');
  fs.mkdirSync(path.join(dir, 'tasks'));
  writeMission('demo', dir);
  const lead = record('demo', 'demo/lead/1', 'lead');
  writeLead('demo', lead);
  writeJson(stateFile('demo'), { state: 'waiting' });
  sendMail('demo', lead.shortId, 'hello');
  const { list, wake } = fake;
  fake.list = async () => [{ ...lead, state: 'done', pid: DEAD_PID, idle: true }];
  fake.wake = async () => {
    throw new Error('claude --bg --resume failed');
  };
  t.after(() => {
    fake.list = list;
    fake.wake = wake;
  });

  const actions = await watcher.tendMission('demo');
  assert.deepStrictEqual(actions.map((action) => action.type), ['wake-lead']);
  const watch = readJson(watchFile('demo'));
  assert.strictEqual(watch.ineffectiveWakes, 1);
  assert.strictEqual(watch.lastWakeAt, null);
  assert.ok(Date.parse(watch.lastIneffectiveAt) >= Date.parse(watch.lastLeadActionAt));
  const lines = logText().split('\n');
  assert.match(lines[0], new RegExp(`^\\S+ demo wake-lead ${lead.shortId}: mail$`));
  assert.match(lines[1], /^\S+ demo error wake-lead: claude --bg --resume failed$/);
  assert.strictEqual(lines.length, 3, logText());
  // Held back for 15 min: the next pass does nothing.
  assert.deepStrictEqual(await watcher.tendMission('demo'), []);
});

// A waiting mission whose lead is recorded but run by no agent: `rows` gives what the stubbed list
// shows, and the wakes are kept in the returned list (the woken session is the recorded one).
function waitingMission(t, rows) {
  const lead = record('demo', 'demo/lead/1', 'lead');
  writeLead('demo', lead);
  writeJson(stateFile('demo'), { state: 'waiting' });
  const woken = [];
  const { list, wake } = fake;
  fake.list = async () => rows(lead);
  fake.wake = async (session, message) => {
    woken.push(message);
    return session;
  };
  t.after(() => {
    fake.list = list;
    fake.wake = wake;
  });
  return { lead, woken };
}

test('act fails the task of a crew lost while the lead waits, then the lead is woken for it', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  const task = await startTask('demo', { id: 'a' });
  const crew = listSessions('demo').find((session) => session.shortId === task.session);
  await fake.stop(crew);
  await waitFor(() => sessionEnded(crew), 30000, 'the crew session to end');
  // The lead is done and idle with its process; the crew is no longer listed, lost for 61 s.
  const { lead, woken } = waitingMission(t, (leadRecord) => [{ ...leadRecord, state: 'done', pid: DEAD_PID, idle: true }]);
  writeJson(watchFile('demo'), { crewLostSince: { [crew.shortId]: new Date(Date.now() - 61 * 1000).toISOString() } });
  writeJson(path.join(missionDir('demo'), 'wait-snapshot.json'), { tasks: { a: 'running', b: 'todo' }, questions: {}, lostSince: {} });

  assert.deepStrictEqual((await watcher.tendMission('demo')).map((action) => action.type), ['mark-failed']);
  const [a] = listTasks('demo');
  assert.strictEqual(a.state, 'failed');
  assert.strictEqual(a.summary, 'crew session ended without a result');
  assert.deepStrictEqual(woken, []);

  assert.deepStrictEqual((await watcher.tendMission('demo')).map((action) => action.type), ['wake-lead']);
  // Its task failed, the crew is no longer counted lost.
  assert.deepStrictEqual(readJson(watchFile('demo')).crewLostSince, {});
  assert.deepStrictEqual(woken, ['Relaylead woke you: task a is now failed. Carry on with the method: run `relaylead task list` first.']);
  const lines = logText().trim().split('\n');
  assert.match(lines[0], new RegExp(`^\\S+ demo crew-lost ${crew.shortId} task a$`));
  assert.match(lines[1], new RegExp(`^\\S+ demo wake-lead ${lead.shortId}: task a is now failed$`));
  assert.strictEqual(lines.length, 2, logText());
});

test('a lead woken while it was not listed is no longer lost', async (t) => {
  freshHome(t);
  const dir = tmpDir('relaylead-project-');
  fs.mkdirSync(path.join(dir, 'tasks'));
  writeMission('demo', dir);
  // Not listed for an hour: the absent lead of a waiting mission, idle; mail is waiting for it.
  const { lead, woken } = waitingMission(t, () => []);
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  writeJson(path.join(missionDir('demo'), 'lead.json'), { ...readJson(path.join(missionDir('demo'), 'lead.json')), startedAt: hourAgo });
  writeJson(watchFile('demo'), { leadLostSince: hourAgo });
  sendMail('demo', lead.shortId, 'hello');

  assert.deepStrictEqual((await watcher.tendMission('demo')).map((action) => action.type), ['wake-lead']);
  assert.strictEqual(woken.length, 1);
  assert.strictEqual(readJson(watchFile('demo')).leadLostSince, null);
});

// Sets each variable of `env` for the test.
function withEnv(t, env) {
  const saved = {};
  for (const [name, value] of Object.entries(env)) {
    saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

// Mission demo, waiting, with a question answered that its lead has not seen.
function answeredMission(t) {
  const { askQuestion, answerQuestion } = require('../core/questions');
  freshHome(t);
  const dir = tmpDir('relaylead-project-');
  fs.mkdirSync(path.join(dir, 'tasks'));
  writeMission('demo', dir);
  askQuestion('demo', { key: 'k', text: 'Which one?', options: ['one', 'two'] });
  answerQuestion('demo', 'q-k', '1');
}

test('a targeted pass waits for a lead still finishing its turn', async (t) => {
  withEnv(t, { RELAYLEAD_HELPER_RECHECK_MS: '200' });
  answeredMission(t);
  // Active for 2 s, then done and idle with its process.
  const idleAt = Date.now() + 2000;
  const { woken } = waitingMission(t, (lead) => [
    Date.now() < idleAt ? { ...lead, state: 'working', pid: DEAD_PID, idle: false } : { ...lead, state: 'done', pid: DEAD_PID, idle: true },
  ]);

  const actions = await watcher.tendMission('demo', { patient: true });
  assert.deepStrictEqual(actions.map((action) => action.type), ['wake-lead']);
  assert.ok(Date.now() >= idleAt);
  assert.deepStrictEqual(woken, ['Relaylead woke you: question q-k is now answered. Carry on with the method: run `relaylead task list` first.']);
});

test('a targeted pass waits out the quiet time', async (t) => {
  withEnv(t, { RELAYLEAD_HELPER_RECHECK_MS: '200', RELAYLEAD_LEAD_QUIET_MS: '3000' });
  answeredMission(t);
  const { woken } = waitingMission(t, (lead) => [{ ...lead, state: 'done', pid: DEAD_PID, idle: true }]);
  const actedAt = Date.now() - 1000;
  writeJson(watchFile('demo'), { lastLeadActionAt: new Date(actedAt).toISOString() });

  assert.deepStrictEqual(await watcher.tendMission('demo'), []);
  const actions = await watcher.tendMission('demo', { patient: true });
  assert.deepStrictEqual(actions.map((action) => action.type), ['wake-lead']);
  assert.ok(Date.now() >= actedAt + 3000);
  assert.strictEqual(woken.length, 1);
});

test('a targeted pass does not restart a watcher the user stopped', async (t) => {
  withEnv(t, { RELAYLEAD_WATCHER: undefined });
  freshHome(t);
  const dir = tmpDir('relaylead-project-');
  fs.mkdirSync(path.join(dir, 'tasks'));
  writeMission('demo', dir);
  waitingMission(t, (lead) => [{ ...lead, state: 'done', pid: DEAD_PID, idle: true }]);
  const stopFile = path.join(home(), 'watcher-loop.stop');
  fs.writeFileSync(stopFile, '');

  const { code } = await watcherRun('--mission', 'demo');
  assert.strictEqual(code, 0);
  assert.strictEqual(fs.existsSync(stopFile), true);
  assert.strictEqual(watcher.watcherRunning().running, false);
  assert.strictEqual(fs.existsSync(path.join(home(), 'watcher-loop.json')), false);
});

// Mission demo, working, whose lead is recorded but run by no agent and listed failed (killed): it is
// absent. fake.wake and fake.launch are left as they are.
function absentLeadMission(t) {
  freshHome(t);
  const dir = tmpDir('relaylead-project-');
  fs.mkdirSync(path.join(dir, 'tasks'));
  writeMission('demo', dir);
  const lead = record('demo', 'demo/lead/1', 'lead');
  writeLead('demo', lead);
  writeJson(stateFile('demo'), { state: 'working' });
  const { list } = fake;
  fake.list = async (mission) => listSessions(mission).map((session) =>
    session.shortId === lead.shortId ? { ...session, state: 'failed', pid: null, idle: true } : { ...session, state: 'done', pid: null, idle: true },
  );
  t.after(() => {
    fake.list = list;
  });
  return lead;
}

function failingAgent(t, names) {
  const saved = Object.fromEntries(names.map((name) => [name, fake[name]]));
  for (const name of names) {
    fake[name] = async () => {
      throw new Error(`${name} failed`);
    };
  }
  t.after(() => Object.assign(fake, saved));
}

test('a failed resume falls back to a new lead session in the same pass', async (t) => {
  withEnv(t, { RELAYLEAD_FAKE_END_FIRST_TURN: '1' });
  const lead = absentLeadMission(t);
  t.after(async () => {
    for (const session of listSessions('demo')) await fake.stop(session);
  });
  // A low context: the lead is to be resumed.
  const { recordHeartbeat } = require('../core/readings');
  recordHeartbeat('demo', lead.shortId, { tool: 'Bash', contextTokens: 50000 });
  failingAgent(t, ['wake']);
  const prompts = [];
  const { launch } = fake;
  fake.launch = async (spec) => {
    prompts.push(spec.prompt);
    return launch(spec);
  };
  t.after(() => {
    fake.launch = launch;
  });

  const actions = await watcher.tendMission('demo');
  assert.deepStrictEqual(actions.map((action) => action.type), ['relaunch-lead']);
  assert.deepStrictEqual(actions[0], { type: 'relaunch-lead', resume: true });
  assert.strictEqual(readJson(path.join(missionDir('demo'), 'lead.json')).sessionName, 'demo/lead/2');
  assert.strictEqual(prompts.length, 1);
  const restart = prompts[0].indexOf('## Restart');
  assert.ok(restart !== -1 && restart < prompts[0].indexOf('## This mission'), prompts[0]);
  assert.match(prompts[0], /The previous lead session demo\/lead\/1 ended unexpectedly/);
  assert.match(logText(), new RegExp(`relaunch-lead ${lead.shortId} as demo/lead/2`));
  const watch = readJson(watchFile('demo'));
  assert.strictEqual(watch.failedRelaunches, 0);
  assert.ok(watch.lastRelaunchAt);
});

test('a relaunch that throws counts once', async (t) => {
  absentLeadMission(t);
  failingAgent(t, ['wake', 'launch']);

  await watcher.tendMission('demo');
  let watch = readJson(watchFile('demo'));
  assert.strictEqual(watch.failedRelaunches, 1);
  assert.strictEqual(watch.lastRelaunchAt, null);
  assert.match(logText(), /demo error relaunch-lead: launch failed/);
  await watcher.tendMission('demo');
  watch = readJson(watchFile('demo'));
  assert.strictEqual(watch.failedRelaunches, 2);
});

test('the breaker stops the mission and says why', async (t) => {
  absentLeadMission(t);
  writeJson(watchFile('demo'), { failedRelaunches: 2, lastRelaunchAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() });

  const actions = await watcher.tendMission('demo');
  assert.ok(actions.some((action) => action.type === 'trip-breaker'));
  const state = readJson(stateFile('demo'));
  const note = 'stopped by the watcher: the lead could not be restarted 3 times in a row';
  assert.deepStrictEqual([state.state, state.note, state.stopping], ['stopped', note, undefined]);
  assert.match(fs.readFileSync(path.join(missionDir('demo'), 'journal.log'), 'utf8'), new RegExp(note));
  assert.match(logText(), /demo breaker-tripped after 3 failed relaunches/);
});

test('a breaker stop that fails is replayed', async (t) => {
  absentLeadMission(t);
  writeJson(watchFile('demo'), { failedRelaunches: 2, lastRelaunchAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
  const missions = require('../core/missions');
  const { stopMission } = missions;
  missions.stopMission = async () => {
    missions.stopMission = stopMission;
    const err = new Error('stop pending');
    err.code = 'stop-pending';
    throw err;
  };
  t.after(() => {
    missions.stopMission = stopMission;
  });

  await watcher.tendMission('demo');
  assert.strictEqual(readJson(stateFile('demo')).state, 'working');
  assert.strictEqual(readJson(watchFile('demo')).tripped, true);
  await watcher.tendMission('demo');
  const state = readJson(stateFile('demo'));
  assert.deepStrictEqual([state.state, state.stopping], ['stopped', undefined]);
});

test('a handover stops the old lead, starts the next one and writes starting', async (t) => {
  withEnv(t, { RELAYLEAD_FAKE_END_FIRST_TURN: '1' });
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  const old = await launchIdleLead(dir, 'demo/lead/1');
  writeLead('demo', old);
  writeJson(stateFile('demo'), { state: 'handover', note: 'a delivered, b next', by: 'demo/lead/1' });
  const seen = [];
  const { launch } = fake;
  fake.launch = async (spec) => {
    seen.push({ state: readJson(stateFile('demo')), prompt: spec.prompt });
    return launch(spec);
  };
  t.after(() => {
    fake.launch = launch;
  });

  const actions = await watcher.tendMission('demo');
  assert.deepStrictEqual(actions.map((action) => action.type), ['hand-over']);
  assert.strictEqual(readJson(path.join(missionDir('demo'), 'lead.json')).sessionName, 'demo/lead/2');
  assert.strictEqual(sessionEnded(old), true);
  assert.strictEqual(seen.length, 1);
  assert.deepStrictEqual([seen[0].state.state, seen[0].state.note], ['starting', 'taken over from demo/lead/1: a delivered, b next']);
  const { prompt } = seen[0];
  const handover = prompt.indexOf('## Handover');
  assert.ok(handover !== -1 && handover < prompt.indexOf('## This mission'), prompt);
  assert.match(prompt, /You take over from the lead session demo\/lead\/1, which handed over with this note: a delivered, b next\./);
  assert.match(logText(), /demo hand-over demo\/lead\/1 to demo\/lead\/2: a delivered, b next/);
});

test('a failed handover counts towards the breaker', async (t) => {
  absentLeadMission(t);
  writeJson(stateFile('demo'), { state: 'handover', note: 'n', by: 'demo/lead/1' });
  failingAgent(t, ['launch']);

  await watcher.tendMission('demo');
  assert.strictEqual(readJson(watchFile('demo')).failedRelaunches, 1);
  assert.strictEqual(readJson(stateFile('demo')).state, 'handover');
  assert.match(logText(), /demo error hand-over: launch failed/);
});

test('a crew told its context is full fails its task and the lead retries it', async (t) => {
  const { recordStatusline } = require('../core/readings');
  withEnv(t, { RELAYLEAD_FAKE_CREW_GATE: tmpDir('relaylead-gate-') });
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  writeJson(stateFile('demo'), { state: 'working' });
  const lead = await launchIdleLead(dir, 'demo/lead/1');
  writeLead('demo', lead);
  const task = await startTask('demo', { id: 'a' });
  const usage = (tokens) => ({ context_window: { context_window_size: 100000, current_usage: { input_tokens: tokens } } });
  recordStatusline('demo', task.session, usage(30000)); // the base
  recordStatusline('demo', task.session, usage(50000)); // past the hard threshold of 48000

  const actions = await watcher.tendMission('demo');
  assert.ok(actions.some((action) => action.type === 'mail' && action.log === `notify-context-full ${task.session} task a`), JSON.stringify(actions));
  await waitFor(() => listTasks('demo')[0].state === 'failed', 30000, 'a to fail', () => missionReport('demo'));
  assert.strictEqual(listTasks('demo')[0].summary, 'context full: fake');
  const io = makeIo();
  assert.strictEqual(await run(['task', 'retry', 'a', '--mission', 'demo'], io), 0, io.err.text);
  assert.strictEqual(listTasks('demo')[0].attempt, 2);
});

test('a pass applies the recommended option of a lead question, and only reminds of a permission one', async (t) => {
  const dir = setupProject(t, 'demo');
  writeJson(path.join(home(), 'config.json'), { delivery: { type: 'files' }, questions: { onTimeout: 'recommended' } });
  writeMission('demo', dir);
  writeLead('demo', record('demo', 'demo/lead/1', 'lead'));
  writeJson(stateFile('demo'), { state: 'working' });
  stubAgent(t);
  ask('demo', { key: 'db', text: 'Which database?', options: ['sqlite', 'postgres'], recommended: 2 });
  const permission = ask('demo', {
    key: 'perm-0123456789ab',
    kind: 'permission',
    text: 'make build',
    options: ['Allow once', 'Always allow in this mission', 'Refuse'],
    recommended: 3,
  });
  // A short delay, and the notifications written down by the script of fixtures/.
  const notifications = path.join(tmpDir(), 'notifications.log');
  const saved = ['RELAYLEAD_QUESTION_TIMEOUT_MS', 'RELAYLEAD_NOTIFY', 'RELAYLEAD_NOTIFY_BIN', 'RELAYLEAD_NOTIFY_LOG'].map((name) => [name, process.env[name]]);
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  Object.assign(process.env, {
    RELAYLEAD_QUESTION_TIMEOUT_MS: '1',
    RELAYLEAD_NOTIFY_BIN: path.join(__dirname, '..', 'fixtures', 'notify-bin.js'),
    RELAYLEAD_NOTIFY_LOG: notifications,
  });
  delete process.env.RELAYLEAD_NOTIFY;
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.strictEqual((await watcherRun('--mission', 'demo')).code, 0);
  const questions = Object.fromEntries(listQuestions('demo').map((question) => [question.id, question]));
  assert.strictEqual(questions['q-db'].answer.choice, 'postgres');
  assert.strictEqual(questions[permission.id].state, 'open');
  assert.match(logText(), /question-timeout-applied q-db postgres/);
  assert.match(logText(), new RegExp(`question-reminder ${permission.id}`));
  await waitFor(() => fs.existsSync(notifications), 5000, 'the reminder');
  assert.match(fs.readFileSync(notifications, 'utf8'), /Question q-perm-0123456789ab waits for your answer: make build/);
  // Reminded once in six hours.
  await watcherRun('--mission', 'demo');
  assert.strictEqual(logText().match(/question-reminder/g).length, 1);
});
