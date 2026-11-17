const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { run } = require('../core/cli');
const { listMissions, lockFile, releaseLock, reapLead } = require('../core/missions');
const { listSessions, recordSession, isAlive } = require('../core/sessions');
const { readJson, writeJson } = require('../core/store');
const { missionDir } = require('../core/paths');
const fake = require('../adapters/fake');
const { tmpDir, makeIo, waitFor, userEnv } = require('../fixtures/helpers');
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

test('name defaults to the folder slug', async (t) => {
  freshHome(t);
  const dir = path.join(tmpDir('relaylead-project-'), 'My Project');
  fs.mkdirSync(dir);

  const result = await cli(['launch', '--agent', 'fake'], { cwd: dir });
  assert.strictEqual(result.code, 0, result.err);
  assert.strictEqual(result.out.trim(), 'my-project');
  assert.strictEqual(readJson(path.join(missionDir('my-project'), 'mission.json')).dir, fs.realpathSync.native(dir));
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
  const pids = listSessions('demo').map((s) => s.pid);
  assert.strictEqual(pids.length, 2);

  const stopped = await cli(['stop', 'demo']);
  assert.strictEqual(stopped.code, 0, stopped.err);
  await waitFor(() => pids.every((pid) => !isAlive(pid)), 30000, 'the sessions to end');

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

  const result = await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir]);
  assert.strictEqual(result.code, 1);
  await waitFor(() => !isAlive(lead.pid), 30000, 'the lead to be stopped');
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
  const [leadPid] = listSessions('demo').filter((s) => s.shortId === lead.shortId).map((s) => s.pid);
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
  await waitFor(() => !isAlive(crew.pid), 30000, 'the crew member to end');
  await waitFor(() => !isAlive(leadPid), 30000, 'the helper to stop the lead');
});

test('the helper exits at once when the lead is no longer working', { timeout: 20000 }, async (t) => {
  freshHome(t);
  const dir = tmpDir('relaylead-project-');
  assert.strictEqual((await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir])).code, 0);
  await waitUntilWorking('demo');
  const [lead] = listSessions('demo');
  await fake.stop(lead); // like a fake lead that exits after `state set done`
  await waitFor(() => !isAlive(lead.pid), 30000, 'the lead to end');
  assert.strictEqual((await cli(['state', 'set', 'done', '--mission', 'demo'])).code, 0);

  const reaped = await cliProcess(['_reap', 'demo']);

  assert.deepStrictEqual([reaped.code, reaped.err], [0, '']);
});

test('done records the pid of the helper, which ends once the lead has ended', { timeout: 20000 }, async (t) => {
  freshHome(t);
  const dir = tmpDir('relaylead-project-');
  assert.strictEqual((await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir])).code, 0);
  await waitUntilWorking('demo');
  const [lead] = listSessions('demo');
  await fake.stop(lead);
  await waitFor(() => !isAlive(lead.pid), 30000, 'the lead to end');

  assert.strictEqual((await cli(['state', 'set', 'done', '--mission', 'demo'])).code, 0);

  const reaper = readJson(path.join(missionDir('demo'), 'reaper.json'));
  assert.ok(Number.isInteger(reaper.pid), JSON.stringify(reaper));
  await waitFor(() => !isAlive(reaper.pid), 15000, 'the helper to end');
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
  await waitFor(() => !isAlive(second.pid), 30000, 'the second crew member to end');
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

  await reapLead('demo');

  await waitFor(() => !isAlive(lead.pid), 30000, 'the lead to be stopped');
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

  await reapLead('demo');

  await waitFor(() => !isAlive(lead.pid), 30000, 'the lead to be stopped');
});

test('the helper writes to the journal when it cannot stop the lead', async (t) => {
  const lead = await launchedLead(t);
  stub(t, 'list', () => async () => [{ ...lead, state: 'done' }]);
  stub(t, 'stop', () => async () => {
    throw new Error('stop failed');
  });

  await reapLead('demo');

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
  fake.stopById = true; // like the claude adapter: stopping a session again is harmless
  t.after(() => {
    delete fake.stopById;
  });

  const first = await cli(['stop', 'demo']);
  assert.deepStrictEqual([first.code, first.out, stopCalls], [0, 'mission demo stopped\n', 1]);
  const again = await cli(['stop', 'demo']);
  assert.deepStrictEqual([again.code, again.out, stopCalls], [0, 'mission demo stopped\n', 2]);
  assert.strictEqual((await cli(['state', 'get', '--mission', 'demo'])).out.trim(), 'stopped');

  // The fake adapter stops by pid, which may belong to another process by now: nothing is done.
  delete fake.stopById;
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
  await waitFor(() => !isAlive(crew.pid), 30000, 'the crew member to end');
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
  await waitFor(() => !isAlive(lead.pid), 30000, 'the lead to end');

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
  await waitFor(() => !isAlive(crew.pid), 30000, 'the crew member to end');
  assert.strictEqual(stateRecord('demo').stopping, undefined);
  const second = await cli(['launch', '--agent', 'fake', '--name', 'two', '--dir', dir]);
  assert.strictEqual(second.code, 0, second.err);
});

test('a lock of a newer mission of the same name is not released', async (t) => {
  freshHome(t);
  const dir = fs.realpathSync.native(tmpDir('relaylead-project-'));
  const lock = lockFile(dir);
  writeJson(lock, { pid: process.pid, mission: 'demo', createdAt: '2026-11-16T10:00:00.000Z' });

  releaseLock(dir, { name: 'demo', createdAt: '2026-11-16T09:00:00.000Z' });

  assert.strictEqual(readJson(lock).createdAt, '2026-11-16T10:00:00.000Z');
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
  fake.stopById = true; // the done mission's sessions are asked again
  t.after(() => {
    delete fake.stopById;
  });

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
  await waitFor(() => !isAlive(crew.pid), 30000, 'the crew member to end');
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

test('remove checks the mission name before removing anything', async (t) => {
  freshHome(t);
  const refused = await cli(['remove', '..']);
  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /usage: relaylead remove <mission> \[--force\]/);
  // missions/.. is RELAYLEAD_HOME itself.
  assert.strictEqual(fs.existsSync(path.join(process.env.RELAYLEAD_HOME, 'config.json')), true);
});
