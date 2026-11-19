const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const watcher = require('../core/watcher');
const { run } = require('../core/cli');
const { t: msg } = require('../core/messages');
const { home, missionDir } = require('../core/paths');
const { writeJson, readJson } = require('../core/store');
const { recordSession, listSessions } = require('../core/sessions');
const fake = require('../adapters/fake');
const { tmpDir, makeIo, waitFor, sessionEnded } = require('../fixtures/helpers');
const { freshHome, setupProject, writeMission, missionReport } = require('../fixtures/missions');

// A pid no process has: a dead holder, or the process of a session listed by a stubbed agent.
const DEAD_PID = 2147483646;

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

// Mission demo with its lead and an extra lead, both run by the fake agent.
async function demoWithTwoLeads(t) {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
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

  const usage = await watcherRun('now');
  assert.strictEqual(usage.code, 1);
  assert.match(usage.err, /usage: relaylead watcher run \[--mission <name>\]/);
});
