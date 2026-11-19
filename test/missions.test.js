const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { run } = require('../core/cli');
const {
  listMissions,
  lockFile,
  releaseLock,
  isStaleFolderLock,
  reapLead,
  markReaperEnded,
  launchLead,
  launchWhileOpen,
  readMission,
} = require('../core/missions');
const { takeOverStaleLock, withMissionLock } = require('../core/mission-lock');
const { listSessions, recordSession, isAlive } = require('../core/sessions');
const { readJson, writeJson } = require('../core/store');
const { missionDir } = require('../core/paths');
const fake = require('../adapters/fake');
const { t: msg } = require('../core/messages');
const { tmpDir, makeIo, waitFor, sessionEnded, userEnv } = require('../fixtures/helpers');
const { freshHome, writeMission } = require('../fixtures/missions');

const BIN = path.join(__dirname, '..', 'bin', 'relaylead.js');

async function cli(args, ioOverrides) {
  const io = makeIo(ioOverrides);
  const code = await run(args, io);
  return { code, out: io.out.text, err: io.err.text };
}

// Runs bin/relaylead.js in its own process.
function cliProcess(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: userEnv(), windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

// The createdAt of the mission, which the helper `relaylead _reap` is started with.
function createdAtOf(name) {
  return readJson(path.join(missionDir(name), 'mission.json')).createdAt;
}

async function waitUntilWorking(name) {
  await waitFor(
    async () => {
      const { out } = await cli(['list']);
      const line = out.split('\n').find((l) => l.startsWith(name + ' '));
      return Boolean(line && line.includes(`${name}/lead/1`) && line.includes('working'));
    },
    30000,
    `${name} to be working`,
  );
}

test('launch creates mission.json with the resolved config and starts a lead', async (t) => {
  freshHome(t);
  const dir = tmpDir('relaylead-project-');
  writeJson(path.join(dir, '.relaylead.json'), { parallel: 2 });

  const result = await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir, '--request', 'Do the tasks']);
  assert.strictEqual(result.code, 0, result.err);
  assert.strictEqual(result.out.trim(), 'demo');

  const mission = readJson(path.join(missionDir('demo'), 'mission.json'));
  assert.strictEqual(mission.dir, fs.realpathSync.native(dir));
  assert.strictEqual(mission.request, 'Do the tasks');
  assert.strictEqual(mission.agent, 'fake');
  assert.strictEqual(mission.config.parallel, 2);
  assert.strictEqual(mission.config.priority, 'normal');

  const lead = readJson(path.join(missionDir('demo'), 'lead.json'));
  assert.strictEqual(lead.sessionName, 'demo/lead/1');
  assert.deepStrictEqual(
    listSessions('demo').map((s) => s.shortId),
    [lead.shortId],
  );
  await waitUntilWorking('demo');
});

test('second launch on the same dir is refused', async (t) => {
  freshHome(t);
  const dir = tmpDir('relaylead-project-');

  const results = await Promise.all(
    ['one', 'two'].map((name) => cliProcess(['launch', '--agent', 'fake', '--name', name, '--dir', dir])),
  );
  assert.deepStrictEqual(results.map((r) => r.code).sort(), [0, 1], JSON.stringify(results));
  const refused = results.find((r) => r.code === 1);
  assert.match(refused.err, /busy/);
  assert.strictEqual(listMissions().length, 1);
});

test('a stale lock is taken over', async (t) => {
  freshHome(t);
  const dir = tmpDir('relaylead-project-');
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  const lock = lockFile(fs.realpathSync.native(dir));
  writeJson(lock, { pid: deadPid, mission: 'crashed' });

  const result = await cli(['launch', '--agent', 'fake', '--name', 'after-crash', '--dir', dir]);
  assert.strictEqual(result.code, 0, result.err);
  assert.strictEqual(readJson(lock).mission, 'after-crash');

  // The end of the mission frees the folder.
  assert.strictEqual((await cli(['state', 'set', 'done', '--mission', 'after-crash'])).code, 0);
  assert.strictEqual(fs.existsSync(lock), false);
});

test('a stale lock being taken over by another launch is left to it', async (t) => {
  freshHome(t);
  const dir = tmpDir('relaylead-project-');
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  const lock = lockFile(fs.realpathSync.native(dir));
  writeJson(lock, { pid: deadPid, mission: 'crashed' });
  // Another launch holds the takeover guard: it may have replaced the lock with its own by now.
  writeJson(lock + '.takeover', { pid: process.pid, command: 'takeover', since: new Date().toISOString() });

  const result = await cli(['launch', '--agent', 'fake', '--name', 'second', '--dir', dir]);

  assert.strictEqual(result.code, 1);
  assert.match(result.err, /busy/);
  assert.strictEqual(readJson(lock).mission, 'crashed');
  assert.strictEqual(fs.existsSync(lock + '.takeover'), true);
});

test('a takeover guard left by a dead launch does not block a later takeover', async (t) => {
  freshHome(t);
  const dir = tmpDir('relaylead-project-');
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  const lock = lockFile(fs.realpathSync.native(dir));
  writeJson(lock, { pid: deadPid, mission: 'crashed' });
  writeJson(lock + '.takeover', { pid: deadPid, command: 'takeover', since: new Date().toISOString() });

  const result = await cli(['launch', '--agent', 'fake', '--name', 'after-crash', '--dir', dir]);

  assert.strictEqual(result.code, 0, result.err);
  assert.strictEqual(readJson(lock).mission, 'after-crash');
  assert.strictEqual(fs.existsSync(lock + '.takeover'), false);
});

test('name defaults to the folder slug', async (t) => {
  freshHome(t);
  const dir = path.join(tmpDir('relaylead-project-'), 'My Project');
  fs.mkdirSync(dir);

  const result = await cli(['launch', '--agent', 'fake'], { cwd: dir });
  assert.strictEqual(result.code, 0, result.err);
  assert.strictEqual(result.out.trim(), 'my-project');
  assert.strictEqual(readJson(path.join(missionDir('my-project'), 'mission.json')).dir, fs.realpathSync.native(dir));
});

test('launch starts the watcher when autoStart is on, says so on stderr, and not otherwise', async (t) => {
  freshHome(t);
  const home = process.env.RELAYLEAD_HOME;
  const loopFile = path.join(home, 'watcher-loop.json');
  const saved = process.env.RELAYLEAD_WATCHER;
  t.after(async () => {
    process.env.RELAYLEAD_HOME = home;
    await cli(['watcher', 'stop']);
    await waitFor(() => !fs.existsSync(loopFile), 30000, 'the loop to end after the test');
    if (saved === undefined) delete process.env.RELAYLEAD_WATCHER;
    else process.env.RELAYLEAD_WATCHER = saved;
  });
  const launch = (name) => cli(['launch', '--agent', 'fake', '--name', name, '--dir', tmpDir('relaylead-project-')]);

  // RELAYLEAD_WATCHER=off, as for the whole test suite: no loop.
  process.env.RELAYLEAD_WATCHER = 'off';
  assert.deepStrictEqual(await launch('muted'), { code: 0, out: 'muted\n', err: '' });
  assert.strictEqual(fs.existsSync(loopFile), false);

  delete process.env.RELAYLEAD_WATCHER;
  writeJson(path.join(home, 'config.json'), { delivery: { type: 'files' }, watcher: { autoStart: false } });
  assert.deepStrictEqual(await launch('quiet'), { code: 0, out: 'quiet\n', err: '' });
  assert.strictEqual(fs.existsSync(loopFile), false);

  writeJson(path.join(home, 'config.json'), { delivery: { type: 'files' } });
  assert.deepStrictEqual(await launch('demo'), { code: 0, out: 'demo\n', err: msg('watcherStarted', { seconds: 300 }) });
  assert.ok(readJson(loopFile).beatAt, 'the loop has written its file');
  // Already running: nothing more is said.
  assert.deepStrictEqual(await launch('again'), { code: 0, out: 'again\n', err: '' });
});

test('stop stops every session of the mission', async (t) => {
  freshHome(t);
  const dir = tmpDir('relaylead-project-');
  const launched = await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir]);
  assert.strictEqual(launched.code, 0, launched.err);
  await waitUntilWorking('demo');
  const crew = await fake.launch({
    mission: 'demo',
    name: 'demo/developer/1',
    role: 'crew',
    profile: null,
    prompt: '',
    cwd: dir,
    env: { RELAYLEAD_MISSION: 'demo' },
    permissionMode: 'allowlist',
  });
  recordSession('demo', crew);
  const sessions = listSessions('demo');
  assert.strictEqual(sessions.length, 2);

  const stopped = await cli(['stop', 'demo']);
  assert.strictEqual(stopped.code, 0, stopped.err);
  await waitFor(() => sessions.every(sessionEnded), 30000, 'the sessions to end');

  assert.strictEqual((await cli(['state', 'get', '--mission', 'demo'])).out.trim(), 'stopped');
  assert.strictEqual(fs.existsSync(lockFile(fs.realpathSync.native(dir))), false);
  const refused = await cli(['state', 'set', 'working'], { env: { RELAYLEAD_MISSION: 'demo' } });
  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /stopped/);
});

test('the lock ignores the letter case of the folder path', async (t) => {
  freshHome(t);
  const dir = path.join(tmpDir('relaylead-project-'), 'CaseProj');
  fs.mkdirSync(dir);
  const otherSpelling = path.join(path.dirname(dir), 'CASEPROJ');
  if (!fs.existsSync(otherSpelling)) {
    t.skip('case-sensitive file system');
    return;
  }

  const first = await cli(['launch', '--agent', 'fake', '--name', 'one', '--dir', dir]);
  assert.strictEqual(first.code, 0, first.err);
  const second = await cli(['launch', '--agent', 'fake', '--name', 'two', '--dir', otherSpelling]);
  assert.strictEqual(second.code, 1);
  assert.match(second.err, /busy/);
});

test('a failure after the lead started stops the lead and leaves nothing behind', async (t) => {
  freshHome(t);
  const dir = tmpDir('relaylead-project-');
  const originalLaunch = fake.launch;
  let lead;
  // Injected failure: another session already holds the lead's registry file.
  fake.launch = async (spec) => {
    lead = await originalLaunch(spec);
    recordSession(spec.mission, { ...lead, sessionId: 'fake-someone-else' });
    return lead;
  };
  t.after(() => {
    fake.launch = originalLaunch;
    if (lead) return fake.stop(lead);
  });
  const stopped = [];
  stub(t, 'stop', (original) => async (session) => {
    stopped.push(session.shortId);
    return original(session);
  });

  const result = await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir]);
  assert.strictEqual(result.code, 1);
  // The stop wrote the lead's stop file. Its ended file went with the mission folder: the agent
  // removes its stop file (outside that folder) as it ends.
  assert.deepStrictEqual(stopped, [lead.shortId]);
  await waitFor(() => !fs.existsSync(lead.stopFile), 30000, 'the lead to be stopped');
  assert.strictEqual(fs.existsSync(path.join(missionDir('demo'), 'mission.json')), false);
  assert.strictEqual(fs.existsSync(lockFile(fs.realpathSync.native(dir))), false);
});

test('a failing stop during the launch cleanup still cleans up and reports the first error', async (t) => {
  freshHome(t);
  const dir = tmpDir('relaylead-project-');
  const originalLaunch = fake.launch;
  const originalStop = fake.stop;
  let lead;
  fake.launch = async (spec) => {
    lead = await originalLaunch(spec);
    recordSession(spec.mission, { ...lead, sessionId: 'fake-someone-else' });
    return lead;
  };
  fake.stop = async () => {
    throw new Error('stop failed');
  };
  let result;
  try {
    result = await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir]);
  } finally {
    fake.launch = originalLaunch;
    fake.stop = originalStop;
  }
  t.after(() => fake.stop(lead));

  assert.strictEqual(result.code, 1);
  assert.match(result.err, /short id/);
  assert.strictEqual(fs.existsSync(missionDir('demo')), false);
  assert.strictEqual(fs.existsSync(lockFile(fs.realpathSync.native(dir))), false);
});

test('stop on a stopped or done mission kills nothing', async (t) => {
  freshHome(t);
  fake.stopById = false; // an adapter that stops by pid, whose finished missions are left alone
  t.after(() => {
    fake.stopById = true;
  });
  const originalStop = fake.stop;
  let stopCalls = 0;
  fake.stop = async (session) => {
    stopCalls++;
    return originalStop(session);
  };
  t.after(() => {
    fake.stop = originalStop;
  });

  const stoppedDir = tmpDir('relaylead-project-');
  assert.strictEqual((await cli(['launch', '--agent', 'fake', '--name', 'stopped', '--dir', stoppedDir])).code, 0);
  await waitUntilWorking('stopped'); // the lead has written its state: nothing more will come from it
  assert.strictEqual((await cli(['stop', 'stopped'])).code, 0);
  assert.strictEqual(stopCalls, 1);
  assert.strictEqual((await cli(['stop', 'stopped'])).code, 0);
  assert.strictEqual(stopCalls, 1);

  const doneDir = tmpDir('relaylead-project-');
  assert.strictEqual((await cli(['launch', '--agent', 'fake', '--name', 'done', '--dir', doneDir])).code, 0);
  await waitUntilWorking('done');
  assert.strictEqual((await cli(['state', 'set', 'done', '--mission', 'done'])).code, 0);
  assert.strictEqual((await cli(['stop', 'done'])).code, 0);
  assert.strictEqual(stopCalls, 1);
  assert.strictEqual((await cli(['state', 'get', '--mission', 'done'])).out.trim(), 'done');
});

test('an unknown method is refused before anything is launched', async (t) => {
  freshHome(t);
  const dir = tmpDir('relaylead-project-');
  writeJson(path.join(dir, '.relaylead.json'), { method: 'ghost' });
  const originalLaunch = fake.launch;
  let launches = 0;
  fake.launch = async (spec) => {
    launches++;
    return originalLaunch(spec);
  };
  t.after(() => {
    fake.launch = originalLaunch;
  });

  const result = await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir]);

  assert.strictEqual(result.code, 1);
  assert.match(result.err, /method "ghost" not found/);
  assert.strictEqual(launches, 0);
  assert.strictEqual(fs.existsSync(missionDir('demo')), false);
  assert.strictEqual(fs.existsSync(lockFile(fs.realpathSync.native(dir))), false);
});

test('done stops the remaining crew, then a helper stops the lead', async (t) => {
  freshHome(t);
  const dir = tmpDir('relaylead-project-');
  assert.strictEqual((await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir])).code, 0);
  await waitUntilWorking('demo');
  const crew = await fake.launch({
    mission: 'demo',
    name: 'demo/developer/1',
    role: 'crew',
    profile: null,
    prompt: '',
    cwd: dir,
    env: { RELAYLEAD_MISSION: 'demo' },
    permissionMode: 'allowlist',
  });
  recordSession('demo', crew);
  const lead = readJson(path.join(missionDir('demo'), 'lead.json'));
  const leadSession = listSessions('demo').find((s) => s.shortId === lead.shortId);
  const originalStop = fake.stop;
  const stopped = [];
  fake.stop = async (session) => {
    stopped.push(session.shortId);
    return originalStop(session);
  };
  // The fake lead never stops working by itself: the helper gives up waiting after 200 ms.
  process.env.RELAYLEAD_REAP_MAX_MS = '200';
  t.after(() => {
    fake.stop = originalStop;
    delete process.env.RELAYLEAD_REAP_MAX_MS;
  });

  const done = await cli(['state', 'set', 'done', '--mission', 'demo']);

  assert.strictEqual(done.code, 0, done.err);
  assert.deepStrictEqual(stopped, [crew.shortId]);
  await waitFor(() => sessionEnded(crew), 30000, 'the crew member to end');
  await waitFor(() => sessionEnded(leadSession), 30000, 'the helper to stop the lead');
});

test('the helper exits at once when the lead is no longer working', { timeout: 20000 }, async (t) => {
  freshHome(t);
  const dir = tmpDir('relaylead-project-');
  assert.strictEqual((await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir])).code, 0);
  await waitUntilWorking('demo');
  const [lead] = listSessions('demo');
  await fake.stop(lead); // like a fake lead that exits after `state set done`
  await waitFor(() => sessionEnded(lead), 30000, 'the lead to end');
  assert.strictEqual((await cli(['state', 'set', 'done', '--mission', 'demo'])).code, 0);

  const reaped = await cliProcess(['_reap', 'demo', createdAtOf('demo')]);

  assert.deepStrictEqual([reaped.code, reaped.err], [0, '']);
});

test('done records the pid of the helper, which ends once the lead has ended', { timeout: 20000 }, async (t) => {
  freshHome(t);
  const dir = tmpDir('relaylead-project-');
  assert.strictEqual((await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir])).code, 0);
  await waitUntilWorking('demo');
  const [lead] = listSessions('demo');
  await fake.stop(lead);
  await waitFor(() => sessionEnded(lead), 30000, 'the lead to end');

  assert.strictEqual((await cli(['state', 'set', 'done', '--mission', 'demo'])).code, 0);

  const reaper = readJson(path.join(missionDir('demo'), 'reaper.json'));
  assert.ok(Number.isInteger(reaper.pid), JSON.stringify(reaper));
  // Written by the helper itself as it exits, with its own pid.
  const ended = path.join(missionDir('demo'), 'reaper-ended.json');
  await waitFor(() => readJson(ended, {}).pid === reaper.pid, 15000, 'the helper to end');
});

test('an old reaper does nothing for a newer mission of the same name', { timeout: 20000 }, async (t) => {
  const lead = await launchedLead(t);
  // Without the check, the helper would stop the lead it sees working after 500 ms.
  setEnv(t, 'RELAYLEAD_REAP_MAX_MS', '500');
  const start = Date.now();

  const reaped = await cliProcess(['_reap', 'demo', '2000-01-01T00:00:00.000Z']);

  assert.deepStrictEqual([reaped.code, reaped.err], [0, '']);
  assert.ok(Date.now() - start < 3000, `ended in ${Date.now() - start} ms`);
  assert.strictEqual(fs.existsSync(lead.stopFile) || sessionEnded(lead), false, 'the lead was stopped');
  assert.strictEqual(fs.existsSync(path.join(missionDir('demo'), 'reaper-ended.json')), false);
});

test('the end of a late helper does not write the removed mission folder again', async (t) => {
  freshHome(t);

  markReaperEnded('demo'); // as after `relaylead remove demo`

  assert.strictEqual(fs.existsSync(missionDir('demo')), false);
});

// A crew session of mission demo that stays alive until stopped.
async function launchCrew(dir, number) {
  const crew = await fake.launch({
    mission: 'demo',
    name: `demo/developer/${number}`,
    role: 'crew',
    profile: null,
    prompt: '',
    cwd: dir,
    env: { RELAYLEAD_MISSION: 'demo' },
    permissionMode: 'allowlist',
  });
  recordSession('demo', crew);
  return crew;
}

// Replaces fake[name] for the test.
function stub(t, name, replacement) {
  const original = fake[name];
  fake[name] = replacement(original);
  t.after(() => {
    fake[name] = original;
  });
}

test('a failing crew stop does not keep the others running, and the folder stays locked', async (t) => {
  freshHome(t);
  const dir = tmpDir('relaylead-project-');
  assert.strictEqual((await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir])).code, 0);
  await waitUntilWorking('demo');
  const first = await launchCrew(dir, 1);
  const second = await launchCrew(dir, 2);
  const lock = lockFile(fs.realpathSync.native(dir));
  const lockSeen = [];
  stub(t, 'stop', (original) => async (session) => {
    lockSeen.push(fs.existsSync(lock));
    if (session.shortId === first.shortId) throw new Error('stop failed');
    return original(session);
  });

  const done = await cli(['state', 'set', 'done', '--mission', 'demo']);

  assert.strictEqual(done.code, 1);
  assert.match(done.err, /stop failed/);
  await waitFor(() => sessionEnded(second), 30000, 'the second crew member to end');
  assert.deepStrictEqual(lockSeen, [true, true]);
  assert.strictEqual(fs.existsSync(lock), true);
  assert.strictEqual((await cli(['state', 'get', '--mission', 'demo'])).out.trim(), 'done');
});

// The lead as the registry knows it, once the mission demo is launched.
async function launchedLead(t) {
  freshHome(t);
  const dir = tmpDir('relaylead-project-');
  assert.strictEqual((await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir])).code, 0);
  await waitUntilWorking('demo');
  return listSessions('demo')[0];
}

test('the helper stops a lead that is done but still has a process', async (t) => {
  const lead = await launchedLead(t);
  stub(t, 'list', () => async () => [{ ...lead, state: 'done' }]);

  await reapLead('demo', createdAtOf('demo'));

  await waitFor(() => sessionEnded(lead), 30000, 'the lead to be stopped');
});

// The list answers these rows in turn, then the last one again. Returns the reads made when the
// lead was stopped, so a test sees when the helper gave up waiting.
function listInTurn(t, lead, rows) {
  let reads = 0;
  const readsAtStop = [];
  stub(t, 'list', () => async () => [{ ...lead, ...rows[Math.min(reads++, rows.length - 1)] }]);
  stub(t, 'stop', (original) => async (session) => {
    readsAtStop.push(reads);
    return original(session);
  });
  return readsAtStop;
}

test('the helper stops a lead claude leaves working but idle after two idle reads', async (t) => {
  const lead = await launchedLead(t);
  const readsAtStop = listInTurn(t, lead, [{ state: 'working', idle: true }]);
  process.env.RELAYLEAD_REAP_MAX_MS = '30000';
  t.after(() => {
    delete process.env.RELAYLEAD_REAP_MAX_MS;
  });

  await reapLead('demo', createdAtOf('demo'));

  assert.deepStrictEqual(readsAtStop, [2]);
  await waitFor(() => sessionEnded(lead), 30000, 'the lead to be stopped');
});

test('the helper does not stop a lead on one idle read followed by a busy one', async (t) => {
  const lead = await launchedLead(t);
  const idle = { state: 'working', idle: true };
  const busy = { state: 'working', idle: false };
  const readsAtStop = listInTurn(t, lead, [idle, busy, idle, idle]);
  process.env.RELAYLEAD_REAP_MAX_MS = '30000';
  t.after(() => {
    delete process.env.RELAYLEAD_REAP_MAX_MS;
  });

  await reapLead('demo', createdAtOf('demo'));

  assert.deepStrictEqual(readsAtStop, [4]);
});

test('the helper waits for the deadline when the idle lead has no process, as during a relaunch', async (t) => {
  const lead = await launchedLead(t);
  const readsAtStop = listInTurn(t, lead, [{ state: 'working', idle: true, pid: null }]);
  process.env.RELAYLEAD_REAP_MAX_MS = '4500';
  t.after(() => {
    delete process.env.RELAYLEAD_REAP_MAX_MS;
  });
  const start = Date.now();

  await reapLead('demo', createdAtOf('demo'));

  assert.ok(Date.now() - start >= 4500, 'stopped before the deadline');
  assert.ok(readsAtStop[0] > 2, `stopped after ${readsAtStop[0]} reads`);
});

test('the helper keeps polling when the list fails, then stops the lead at the deadline', async (t) => {
  const lead = await launchedLead(t);
  stub(t, 'list', () => async () => {
    throw new Error('list failed');
  });
  process.env.RELAYLEAD_REAP_MAX_MS = '200';
  t.after(() => {
    delete process.env.RELAYLEAD_REAP_MAX_MS;
  });

  await reapLead('demo', createdAtOf('demo'));

  await waitFor(() => sessionEnded(lead), 30000, 'the lead to be stopped');
});

test('the helper writes to the journal when it cannot stop the lead', async (t) => {
  const lead = await launchedLead(t);
  stub(t, 'list', () => async () => [{ ...lead, state: 'done' }]);
  stub(t, 'stop', () => async () => {
    throw new Error('stop failed');
  });

  await reapLead('demo', createdAtOf('demo'));

  const journal = fs.readFileSync(path.join(missionDir('demo'), 'journal.log'), 'utf8');
  assert.match(journal, new RegExp(`could not stop the lead ${lead.shortId}: stop failed`));
});

test('stop runs again for an adapter that stops by id, and says when it had nothing to do', async (t) => {
  freshHome(t);
  const dir = tmpDir('relaylead-project-');
  assert.strictEqual((await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir])).code, 0);
  await waitUntilWorking('demo');
  let stopCalls = 0;
  stub(t, 'stop', (original) => async (session) => {
    stopCalls++;
    return original(session);
  });

  const first = await cli(['stop', 'demo']);
  assert.deepStrictEqual([first.code, first.out, stopCalls], [0, 'mission demo stopped\n', 1]);
  const again = await cli(['stop', 'demo']);
  assert.deepStrictEqual([again.code, again.out, stopCalls], [0, 'mission demo stopped\n', 2]);
  assert.strictEqual((await cli(['state', 'get', '--mission', 'demo'])).out.trim(), 'stopped');

  // An adapter that stops by pid, which may belong to another process by now: nothing is done.
  fake.stopById = false;
  t.after(() => {
    fake.stopById = true;
  });
  const refused = await cli(['stop', 'demo']);
  assert.deepStrictEqual([refused.code, refused.out, stopCalls], [0, 'mission demo is already stopped; nothing to do\n', 2]);
});

test('done stops the crew sessions of the registry when the adapter list fails', async (t) => {
  freshHome(t);
  const dir = tmpDir('relaylead-project-');
  assert.strictEqual((await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir])).code, 0);
  await waitUntilWorking('demo');
  const crew = await launchCrew(dir, 1);
  const lead = readJson(path.join(missionDir('demo'), 'lead.json'));
  stub(t, 'list', () => async () => {
    throw new Error('list failed');
  });
  const stopped = [];
  stub(t, 'stop', (original) => async (session) => {
    stopped.push(session.shortId);
    return original(session);
  });
  process.env.RELAYLEAD_REAP_MAX_MS = '200'; // the helper, in its own process, stops the lead soon
  t.after(() => {
    delete process.env.RELAYLEAD_REAP_MAX_MS;
  });

  const done = await cli(['state', 'set', 'done', '--mission', 'demo']);

  assert.strictEqual(done.code, 0, done.err);
  assert.deepStrictEqual(stopped, [crew.shortId]);
  assert.ok(!stopped.includes(lead.shortId));
  await waitFor(() => sessionEnded(crew), 30000, 'the crew member to end');
});

test('once done, the lead can no longer declare another state', async (t) => {
  freshHome(t);
  writeMission('demo', tmpDir('relaylead-project-')); // no lead: the test plays it
  const set = (state) => cli(['state', 'set', state, '--mission', 'demo']);
  assert.strictEqual((await set('done')).code, 0);

  for (const state of ['working', 'waiting']) {
    const refused = await set(state);
    assert.strictEqual(refused.code, 1);
    assert.match(refused.err, /mission "demo" is done/);
  }
  assert.strictEqual((await cli(['state', 'get', '--mission', 'demo'])).out.trim(), 'done');
});

// state.json as the core wrote it.
function stateRecord(name) {
  return readJson(path.join(missionDir(name), 'state.json'));
}

test('the lock follows the mission state, not the lead pid', async (t) => {
  freshHome(t);
  const dir = tmpDir('relaylead-project-');
  assert.strictEqual((await cli(['launch', '--agent', 'fake', '--name', 'one', '--dir', dir])).code, 0);
  await waitUntilWorking('one');
  const [lead] = listSessions('one');
  await fake.stop(lead); // the lead's process is gone, as when the agent's daemon restarts it elsewhere
  await waitFor(() => sessionEnded(lead), 30000, 'the lead to end');

  const refused = await cli(['launch', '--agent', 'fake', '--name', 'two', '--dir', dir]);
  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /busy with mission "one"/);

  assert.strictEqual((await cli(['stop', 'one'])).code, 0);
  const second = await cli(['launch', '--agent', 'fake', '--name', 'two', '--dir', dir]);
  assert.strictEqual(second.code, 0, second.err);
});

test('a stop that could not stop every session keeps the folder', async (t) => {
  freshHome(t);
  const dir = tmpDir('relaylead-project-');
  assert.strictEqual((await cli(['launch', '--agent', 'fake', '--name', 'one', '--dir', dir])).code, 0);
  await waitUntilWorking('one');
  const original = fake.stop;
  let failed;
  fake.stop = async () => {
    throw new Error('stop failed');
  };
  try {
    failed = await cli(['stop', 'one']);
  } finally {
    fake.stop = original;
  }

  assert.strictEqual(failed.code, 1);
  assert.strictEqual(stateRecord('one').stopping, true);
  const refused = await cli(['launch', '--agent', 'fake', '--name', 'two', '--dir', dir]);
  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /busy with mission "one" \(stopped, stopping\)/);
  const listed = await cli(['list']);
  assert.match(listed.out, /^one {2}stopped, stopping {2}/m);

  const again = await cli(['stop', 'one']);
  assert.strictEqual(again.code, 0, again.err);
  assert.strictEqual(stateRecord('one').stopping, undefined);
  const second = await cli(['launch', '--agent', 'fake', '--name', 'two', '--dir', dir]);
  assert.strictEqual(second.code, 0, second.err);
});

test('a failed crew stop at done keeps the folder', async (t) => {
  freshHome(t);
  const dir = tmpDir('relaylead-project-');
  assert.strictEqual((await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir])).code, 0);
  await waitUntilWorking('demo');
  const crew = await launchCrew(dir, 1);
  const original = fake.stop;
  let failed;
  fake.stop = async (session) => {
    if (session.shortId === crew.shortId) throw new Error('stop failed');
    return original(session);
  };
  try {
    failed = await cli(['state', 'set', 'done', '--mission', 'demo']);
  } finally {
    fake.stop = original;
  }

  assert.strictEqual(failed.code, 1);
  assert.strictEqual(stateRecord('demo').stopping, true);
  const refused = await cli(['launch', '--agent', 'fake', '--name', 'two', '--dir', dir]);
  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /busy with mission "demo" \(done, stopping\)/);

  const again = await cli(['state', 'set', 'done', '--mission', 'demo']);
  assert.strictEqual(again.code, 0, again.err);
  await waitFor(() => sessionEnded(crew), 30000, 'the crew member to end');
  assert.strictEqual(stateRecord('demo').stopping, undefined);
  const second = await cli(['launch', '--agent', 'fake', '--name', 'two', '--dir', dir]);
  assert.strictEqual(second.code, 0, second.err);
});

test('a lock of a newer mission of the same name is not released', async (t) => {
  freshHome(t);
  const dir = fs.realpathSync.native(tmpDir('relaylead-project-'));
  const lock = lockFile(dir);
  writeJson(lock, { pid: process.pid, mission: 'demo', createdAt: '2026-11-16T10:00:00.000Z' });

  await releaseLock(dir, { name: 'demo', createdAt: '2026-11-16T09:00:00.000Z' });

  assert.strictEqual(readJson(lock).createdAt, '2026-11-16T10:00:00.000Z');
});

test('a mission does not release its lock while a takeover holds the guard', async (t) => {
  freshHome(t);
  const dir = fs.realpathSync.native(tmpDir('relaylead-project-'));
  const lock = lockFile(dir);
  const mission = { name: 'demo', createdAt: '2026-11-16T10:00:00.000Z' };
  writeJson(lock, { pid: process.pid, mission: mission.name, createdAt: mission.createdAt });
  // The taker may have replaced the lock with its own by now: only it may delete the lock.
  writeJson(lock + '.takeover', { pid: process.pid, command: 'takeover', since: new Date().toISOString() });

  await releaseLock(dir, mission);

  assert.strictEqual(readJson(lock).mission, 'demo');
  assert.strictEqual(fs.existsSync(lock + '.takeover'), true);
});

test('a takeover guard left by a dead taker does not keep a mission from releasing its lock', async (t) => {
  freshHome(t);
  const dir = fs.realpathSync.native(tmpDir('relaylead-project-'));
  const lock = lockFile(dir);
  const mission = { name: 'demo', createdAt: '2026-11-16T10:00:00.000Z' };
  writeJson(lock, { pid: process.pid, mission: mission.name, createdAt: mission.createdAt });
  // An empty guard this old was left by a taker that crashed before writing its pid.
  fs.writeFileSync(lock + '.takeover', '');
  const longAgo = new Date(Date.now() - 20 * 1000);
  fs.utimesSync(lock + '.takeover', longAgo, longAgo);

  await releaseLock(dir, mission);

  assert.strictEqual(fs.existsSync(lock), false);
  assert.strictEqual(fs.existsSync(lock + '.takeover'), false);
});

test('a mission releases its own lock and leaves no takeover guard', async (t) => {
  freshHome(t);
  const dir = fs.realpathSync.native(tmpDir('relaylead-project-'));
  const lock = lockFile(dir);
  const mission = { name: 'demo', createdAt: '2026-11-16T10:00:00.000Z' };
  writeJson(lock, { pid: process.pid, mission: mission.name, createdAt: mission.createdAt });

  await releaseLock(dir, mission);

  assert.strictEqual(fs.existsSync(lock), false);
  assert.strictEqual(fs.existsSync(lock + '.takeover'), false);
});

test('a folder lock that is gone is not stale', (t) => {
  freshHome(t);
  const dir = fs.realpathSync.native(tmpDir('relaylead-project-'));

  assert.strictEqual(isStaleFolderLock(dir), false);
});

test('a takeover that finds the folder lock gone does not delete the lock created right after', async (t) => {
  freshHome(t);
  const dir = fs.realpathSync.native(tmpDir('relaylead-project-'));
  const lock = lockFile(dir);
  fs.mkdirSync(path.dirname(lock), { recursive: true });

  // The lock is gone when the taker checks it; another launch creates its own just after.
  const taken = await takeOverStaleLock(lock, () => {
    const stale = isStaleFolderLock(dir);
    writeJson(lock, { pid: process.pid, mission: 'other', createdAt: new Date().toISOString() });
    return stale;
  });

  assert.strictEqual(taken, false);
  assert.strictEqual(readJson(lock).mission, 'other');
});

test('a lock naming a mission of another folder is taken over', async (t) => {
  freshHome(t);
  const dir = fs.realpathSync.native(tmpDir('relaylead-project-'));
  writeMission('elsewhere', fs.realpathSync.native(tmpDir('relaylead-project-')));
  writeJson(path.join(missionDir('elsewhere'), 'state.json'), { state: 'working', updatedAt: new Date().toISOString() });
  const { createdAt } = readJson(path.join(missionDir('elsewhere'), 'mission.json'));
  const lock = lockFile(dir);
  writeJson(lock, { pid: process.pid, mission: 'elsewhere', createdAt });

  const result = await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir]);

  assert.strictEqual(result.code, 0, result.err);
  assert.strictEqual(readJson(lock).mission, 'demo');
});

test('a lock written before this lot is released by its mission', async (t) => {
  freshHome(t);
  const dir = fs.realpathSync.native(tmpDir('relaylead-project-'));
  writeMission('demo', dir); // no lead: the test plays it
  const lock = lockFile(dir);
  writeJson(lock, { pid: process.pid, mission: 'demo' });

  const done = await cli(['state', 'set', 'done', '--mission', 'demo']);

  assert.strictEqual(done.code, 0, done.err);
  assert.strictEqual(fs.existsSync(lock), false);
});

test('an old stopping marker does not replay a stop by pid', async (t) => {
  freshHome(t);
  const dir = fs.realpathSync.native(tmpDir('relaylead-project-'));
  writeMission('demo', dir);
  const { createdAt } = readJson(path.join(missionDir('demo'), 'mission.json'));
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  writeJson(path.join(missionDir('demo'), 'state.json'), { state: 'stopped', stopping: true, updatedAt: twoHoursAgo });
  // A session whose pid may belong to another process by now.
  const oldPid = spawnSync(process.execPath, ['-e', '']).pid;
  recordSession('demo', { sessionId: 'fake-old', shortId: 'old00000', name: 'demo/lead/1', role: 'lead', pid: oldPid });
  const lock = lockFile(dir);
  writeJson(lock, { pid: process.pid, mission: 'demo', createdAt });
  let stopCalls = 0;
  stub(t, 'stop', () => async () => {
    stopCalls++;
  });
  fake.stopById = false; // an adapter that stops by pid
  t.after(() => {
    fake.stopById = true;
  });

  const result = await cli(['stop', 'demo']);

  assert.strictEqual(result.code, 0, result.err);
  assert.strictEqual(
    result.out,
    'the sessions of mission demo were not stopped again: their process ids are more than an hour old\n',
  );
  assert.strictEqual(stopCalls, 0);
  assert.strictEqual(stateRecord('demo').stopping, undefined);
  assert.strictEqual(stateRecord('demo').state, 'stopped');
  assert.strictEqual(fs.existsSync(lock), false);
});

test('remove stops the fake sessions by id', async (t) => {
  freshHome(t);
  writeMission('demo', tmpDir('relaylead-project-')); // no lead: the test plays it
  await launchCrew(tmpDir('relaylead-project-'), 1);
  // Written by the test, not by `state set done`: the crew session is left running.
  writeJson(path.join(missionDir('demo'), 'state.json'), { state: 'done' });
  // remove waits for each stop before deleting the mission folder: the session's ended file, which
  // goes with that folder, is checked here while it is still there.
  let stopCalls = 0;
  stub(t, 'stop', (original) => async (session) => {
    stopCalls++;
    await original(session);
    await waitFor(() => sessionEnded(session), 30000, 'the crew member to end');
  });

  const removed = await cli(['remove', 'demo']);

  assert.strictEqual(removed.code, 0, removed.err);
  assert.strictEqual(stopCalls, 1);
  assert.strictEqual(fs.existsSync(missionDir('demo')), false);
});

test('an old stopping marker stops the fake sessions again by id', async (t) => {
  freshHome(t);
  writeMission('demo', tmpDir('relaylead-project-')); // no lead: the test plays it
  const crew = await launchCrew(tmpDir('relaylead-project-'), 1);
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  writeJson(path.join(missionDir('demo'), 'state.json'), { state: 'stopped', stopping: true, updatedAt: twoHoursAgo });

  const result = await cli(['stop', 'demo']);

  assert.deepStrictEqual([result.code, result.out], [0, 'mission demo stopped\n'], result.err);
  await waitFor(() => sessionEnded(crew), 30000, 'the crew member to end');
  assert.strictEqual(stateRecord('demo').stopping, undefined);
  assert.strictEqual(stateRecord('demo').state, 'stopped');
});

test('an empty folder lock older than 10 s is taken over', async (t) => {
  freshHome(t);
  const dir = fs.realpathSync.native(tmpDir('relaylead-project-'));
  const lock = lockFile(dir);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, '');

  // A fresh empty lock: another launch has just created it and is writing it.
  const refused = await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir]);
  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /busy/);

  const longAgo = new Date(Date.now() - 20 * 1000);
  fs.utimesSync(lock, longAgo, longAgo);
  const result = await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir]);
  assert.strictEqual(result.code, 0, result.err);
  assert.strictEqual(readJson(lock).mission, 'demo');
});

test('stop of a done mission says it is done', async (t) => {
  freshHome(t);
  writeMission('demo', tmpDir('relaylead-project-')); // no lead: the test plays it
  assert.strictEqual((await cli(['state', 'set', 'done', '--mission', 'demo'])).code, 0);

  const stopped = await cli(['stop', 'demo']);

  assert.deepStrictEqual([stopped.code, stopped.out, stopped.err], [0, 'mission demo is done; its remaining sessions were stopped\n', '']);
  assert.strictEqual(stateRecord('demo').state, 'done');
});

test('a session the adapter no longer lists has no process to wait for', async (t) => {
  freshHome(t);
  writeMission('demo', tmpDir('relaylead-project-')); // no lead: the test plays it
  // A registry pid now used by an unrelated process.
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => unrelated.kill());
  recordSession('demo', { sessionId: 'fake-gone', shortId: 'gone0000', name: 'demo/developer/1', role: 'crew', pid: unrelated.pid });
  stub(t, 'list', () => async () => []); // the adapter lists no session
  stub(t, 'stop', () => async () => {}); // the session is unknown: nothing to stop
  process.env.RELAYLEAD_STOP_WAIT_MS = '300';
  t.after(() => {
    delete process.env.RELAYLEAD_STOP_WAIT_MS;
  });

  const stopped = await cli(['stop', 'demo']);

  assert.deepStrictEqual([stopped.code, stopped.out, stopped.err], [0, 'mission demo stopped\n', '']);
  assert.ok(isAlive(unrelated.pid));
});

// A live process with no link to the mission, ended by the test through its handle.
function unrelatedProcess(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(() => child.kill());
  return { pid: child.pid, end: () => (child.kill(), exited) };
}

// A crew session of mission demo recorded with `pid`. Like claude (measured fact 1), the adapter
// lists it with that pid until it is stopped, then without one; from the start when `alreadyStopped`.
function listedWithPidUntilStopped(t, pid, { alreadyStopped = false } = {}) {
  writeMission('demo', tmpDir('relaylead-project-')); // no lead: the test plays it
  const session = { sessionId: 'fake-crew', shortId: 'crew0000', name: 'demo/developer/1', role: 'crew', pid };
  recordSession('demo', session);
  let stopped = alreadyStopped;
  stub(t, 'list', () => async () => [{ ...session, state: stopped ? 'stopped' : 'working', pid: stopped ? null : pid }]);
  stub(t, 'stop', () => async () => {
    stopped = true;
  });
}

// Sets the variable for the test.
function setEnv(t, name, value) {
  process.env[name] = value;
  t.after(() => {
    delete process.env[name];
  });
}

test(
  'a stop waits on the adapter list, not on a pid now used by another process',
  { skip: process.platform !== 'win32' && 'Windows only: elsewhere, the wait for the pid is not bounded' },
  async (t) => {
    freshHome(t);
    const unrelated = unrelatedProcess(t);
    listedWithPidUntilStopped(t, unrelated.pid);
    setEnv(t, 'RELAYLEAD_CLAUDE_WAKE_SETTLE_MS', '1000');
    const start = Date.now();

    const stopped = await cli(['stop', 'demo']);

    const elapsed = Date.now() - start;
    assert.deepStrictEqual([stopped.code, stopped.out, stopped.err], [0, 'mission demo stopped\n', '']);
    // list and stop answer at once: only the wait for the pid from before takes this long.
    assert.ok(elapsed >= 1000 && elapsed < 8000, `stopped in ${elapsed} ms`);
    assert.ok(isAlive(unrelated.pid));
  },
);

test(
  'a stop is not over while the process from before lives, even once the list shows no pid',
  { skip: process.platform === 'win32' && 'POSIX only: on Windows, the wait for the pid is bounded' },
  async (t) => {
    freshHome(t);
    const lingering = unrelatedProcess(t);
    listedWithPidUntilStopped(t, lingering.pid);
    setEnv(t, 'RELAYLEAD_STOP_WAIT_MS', '600');

    const refused = await cli(['stop', 'demo']);
    assert.strictEqual(refused.code, 1);
    assert.match(refused.err, /process is still running/);

    // Run again, the stop finds the session listed without a pid: it waits for the registry pid.
    const replayed = await cli(['stop', 'demo']);
    assert.strictEqual(replayed.code, 1);
    assert.match(replayed.err, /process is still running/);

    await lingering.end();
    const stopped = await cli(['stop', 'demo']);
    assert.strictEqual(stopped.code, 0, stopped.err);
  },
);

test('a session listed without a pid is waited for on its registry pid, at most the short bound', async (t) => {
  freshHome(t);
  // As for a stop run again, or within the 1.5 s when the row has lost its pid (measured fact 1).
  const unrelated = unrelatedProcess(t); // or a pid now used by another process
  listedWithPidUntilStopped(t, unrelated.pid, { alreadyStopped: true });
  setEnv(t, 'RELAYLEAD_CLAUDE_WAKE_SETTLE_MS', '1000');
  const start = Date.now();

  const stopped = await cli(['stop', 'demo']);

  const elapsed = Date.now() - start;
  assert.deepStrictEqual([stopped.code, stopped.out, stopped.err], [0, 'mission demo stopped\n', '']);
  // list and stop answer at once: only the wait for the registry pid takes this long.
  assert.ok(elapsed >= 1000 && elapsed < 8000, `stopped in ${elapsed} ms`);
  assert.ok(isAlive(unrelated.pid));
});

test('a stop judges on the pid only when the list fails', async (t) => {
  // The adapter lists the session with its pid until it is stopped, then fails.
  let session = null;
  let stopped = false;
  stub(t, 'list', () => async () => {
    if (stopped) throw new Error('list failed');
    return [{ ...session, state: 'working' }];
  });
  stub(t, 'stop', () => async () => {
    stopped = true;
  });
  setEnv(t, 'RELAYLEAD_STOP_WAIT_MS', '300');
  const stopWith = (pid) => {
    freshHome(t);
    writeMission('demo', tmpDir('relaylead-project-')); // no lead: the test plays it
    session = { sessionId: 'fake-crew', shortId: 'crew0000', name: 'demo/developer/1', role: 'crew', pid };
    recordSession('demo', session);
    stopped = false;
    return cli(['stop', 'demo']);
  };

  const alive = await stopWith(unrelatedProcess(t).pid);
  assert.strictEqual(alive.code, 1);
  assert.match(alive.err, /process is still running/);

  const impossible = await stopWith(2147483646); // a pid that cannot exist
  assert.deepStrictEqual([impossible.code, impossible.err], [0, '']);
});

test('remove waits for the end of state set done', async (t) => {
  freshHome(t);
  writeMission('demo', tmpDir('relaylead-project-')); // no lead: the test plays it
  const crew = await launchCrew(tmpDir('relaylead-project-'), 1);
  let stopCalled = false;
  stub(t, 'stop', (original) => async (session) => {
    stopCalled = true;
    await new Promise((resolve) => setTimeout(resolve, 500));
    return original(session);
  });
  const ended = [];

  const done = cli(['state', 'set', 'done', '--mission', 'demo']).then((result) => {
    ended.push('done');
    return result;
  });
  await waitFor(() => stopCalled, 10000, 'state set done to stop the crew');
  const removed = await cli(['remove', 'demo']);
  ended.push('remove');

  assert.strictEqual(removed.code, 0, removed.err);
  assert.strictEqual((await done).code, 0);
  assert.deepStrictEqual(ended, ['done', 'remove']);
  // Its ended file went with the mission folder: the agent removes its stop file (outside that
  // folder) as it ends.
  await waitFor(() => !fs.existsSync(crew.stopFile), 30000, 'the crew member to end');
  assert.strictEqual(fs.existsSync(missionDir('demo')), false);
});

test('remove finishes an interrupted removal', async (t) => {
  freshHome(t);
  const dir = tmpDir('relaylead-project-');
  writeJson(path.join(missionDir('demo'), 'reaper.json'), { pid: 0, startedAt: new Date().toISOString() });

  const removed = await cli(['remove', 'demo']);

  assert.strictEqual(removed.code, 0, removed.err);
  assert.strictEqual(fs.existsSync(missionDir('demo')), false);
  const launched = await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir]);
  assert.strictEqual(launched.code, 0, launched.err);
});

test('remove leaves a mission folder being launched', async (t) => {
  freshHome(t);
  fs.mkdirSync(missionDir('demo'), { recursive: true }); // reserved, mission.json not written yet
  writeJson(lockFile(fs.realpathSync.native(tmpDir('relaylead-project-'))), { pid: process.pid, mission: 'demo' });

  const refused = await cli(['remove', 'demo']);

  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /busy/);
  assert.strictEqual(fs.existsSync(missionDir('demo')), true);
});

test('a launch lock older than 15 min does not hold a mission name, even with a live pid', async (t) => {
  freshHome(t);
  fs.mkdirSync(missionDir('demo'), { recursive: true }); // no mission.json
  const dir = fs.realpathSync.native(tmpDir('relaylead-project-'));
  const lock = lockFile(dir);
  writeJson(lock, { pid: process.pid, mission: 'demo' }); // a pid that may now be another process
  const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
  fs.utimesSync(lock, twentyMinutesAgo, twentyMinutesAgo);

  const removed = await cli(['remove', 'demo']);

  assert.strictEqual(removed.code, 0, removed.err);
  assert.strictEqual(fs.existsSync(missionDir('demo')), false);
  assert.strictEqual(isStaleFolderLock(dir), true); // a launch may take the folder over
});

test('remove checks the mission name before removing anything', async (t) => {
  freshHome(t);
  const refused = await cli(['remove', '..']);
  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /usage: relaylead remove <mission> \[--force\]/);
  // missions/.. is RELAYLEAD_HOME itself.
  assert.strictEqual(fs.existsSync(path.join(process.env.RELAYLEAD_HOME, 'config.json')), true);
});

test('a launch stops the session it started when the mission was stopped meanwhile', async (t) => {
  freshHome(t);
  writeMission('demo', tmpDir('relaylead-project-'));
  const stateFile = path.join(missionDir('demo'), 'state.json');
  const session = { shortId: 'aaaa1111' };
  const stopped = [];
  const stop = async (stoppedSession) => {
    stopped.push(stoppedSession);
  };

  // Stopped while the session was being launched: it is stopped, and the launch refused.
  const launch = async () => {
    writeJson(stateFile, { state: 'stopped', stopping: true });
    return session;
  };
  await assert.rejects(launchWhileOpen('demo', launch, stop), { code: 'mission-stopped' });
  assert.deepStrictEqual(stopped, [session]);

  // Already stopped, or done: nothing is launched.
  let launches = 0;
  const counted = async () => {
    launches++;
    return session;
  };
  await assert.rejects(launchWhileOpen('demo', counted, stop), { code: 'mission-stopped' });
  writeJson(stateFile, { state: 'done' });
  await assert.rejects(launchWhileOpen('demo', counted, stop), { code: 'mission-done' });
  assert.strictEqual(launches, 0);

  // Open all along: the session is returned.
  writeJson(stateFile, { state: 'working' });
  assert.strictEqual(await launchWhileOpen('demo', counted, stop), session);
  assert.strictEqual(stopped.length, 1);
});

test('a lead name is never given twice, even when a launch left no record', async (t) => {
  freshHome(t);
  writeMission('demo', tmpDir('relaylead-project-'));
  recordSession('demo', { sessionId: 'fake-old', shortId: 'aaaa1111', name: 'demo/lead/1', role: 'lead', pid: 2147483646 });
  // Lead 3 was reserved by a launch that recorded nothing (it crashed, or failed).
  writeJson(path.join(missionDir('demo'), 'lead-launch.json'), { n: 3, name: 'demo/lead/3', at: new Date().toISOString() });

  const lead = await withMissionLock('demo', 'test', () => launchLead(readMission('demo')));

  assert.strictEqual(lead.name, 'demo/lead/4');
  assert.strictEqual(readJson(path.join(missionDir('demo'), 'lead.json')).sessionName, 'demo/lead/4');
  const reserved = readJson(path.join(missionDir('demo'), 'lead-launch.json'));
  assert.strictEqual(reserved.n, 4);
  assert.strictEqual(reserved.name, 'demo/lead/4');
  assert.ok(listSessions('demo').some((session) => session.name === 'demo/lead/4'));
});

test('the restart and handover sections come before the mission', async (t) => {
  freshHome(t);
  const prompts = [];
  stub(t, 'launch', (original) => async (spec) => {
    prompts.push(spec.prompt);
    return original(spec);
  });
  const dir = tmpDir('relaylead-project-');
  assert.strictEqual((await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir])).code, 0);
  const section = '## Restart\n\nThe previous lead session demo/lead/1 ended unexpectedly.';

  await withMissionLock('demo', 'test', () => launchLead(readMission('demo'), { section }));

  assert.strictEqual(prompts.length, 2);
  assert.ok(!prompts[0].includes('## Restart'), 'the first lead gets no section');
  const at = prompts[1].indexOf(section);
  assert.ok(at > 0, prompts[1]);
  assert.ok(at < prompts[1].indexOf('## This mission'), prompts[1]);
});

// The fake agent's launch, made to return only once the lead's first command (`state set working`)
// has run: like claude's, which returns after the first turn has started.
function launchReturningAfterFirstCommand(t) {
  stub(t, 'launch', (original) => async (spec) => {
    const session = await original(spec);
    if (spec.role === 'lead') {
      const ran = () => fs.existsSync(session.logFile) && /end relaylead state set working|relaylead state set working failed/.test(fs.readFileSync(session.logFile, 'utf8'));
      await waitFor(ran, 30000, `the first command of ${spec.name}`);
    }
    return session;
  });
}

function logOf(name) {
  const session = listSessions('demo').find((candidate) => candidate.name === name);
  return fs.readFileSync(session.logFile, 'utf8');
}

test('a new lead that runs its first command before lead.json names it is accepted', async (t) => {
  freshHome(t);
  launchReturningAfterFirstCommand(t);
  const dir = tmpDir('relaylead-project-');
  const stateFile = path.join(missionDir('demo'), 'state.json');

  // First launch: no lead.json yet.
  assert.strictEqual((await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir])).code, 0);
  assert.doesNotMatch(logOf('demo/lead/1'), /failed/);
  const first = readJson(stateFile);
  assert.strictEqual(first.state, 'working');
  assert.ok(first.updatedAt <= readJson(path.join(missionDir('demo'), 'lead.json')).startedAt);

  // A second lead, while lead.json still names the first one.
  writeJson(stateFile, { state: 'starting' });
  await withMissionLock('demo', 'test', () => launchLead(readMission('demo')));
  assert.doesNotMatch(logOf('demo/lead/2'), /failed/);
  const second = readJson(stateFile);
  assert.strictEqual(second.state, 'working');
  const lead = readJson(path.join(missionDir('demo'), 'lead.json'));
  assert.strictEqual(lead.sessionName, 'demo/lead/2');
  assert.ok(second.updatedAt <= lead.startedAt);
});
