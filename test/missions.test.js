const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { run } = require('../core/cli');
const { listMissions, lockFile } = require('../core/missions');
const { listSessions, recordSession, isAlive } = require('../core/sessions');
const { readJson, writeJson } = require('../core/store');
const { missionDir } = require('../core/paths');
const fake = require('../adapters/fake');
const { tmpDir, makeIo, waitFor } = require('../fixtures/helpers');

const BIN = path.join(__dirname, '..', 'bin', 'relaylead.js');

// Each test gets a fresh RELAYLEAD_HOME, and every session it started is killed afterwards.
function freshHome(t) {
  const home = tmpDir('relaylead-home-');
  process.env.RELAYLEAD_HOME = home;
  // Kill every recorded session directly: stopMission leaves a finished mission alone.
  t.after(async () => {
    process.env.RELAYLEAD_HOME = home;
    for (const mission of listMissions()) {
      for (const session of listSessions(mission.name)) await fake.stop(session);
    }
  });
}

async function cli(args, ioOverrides) {
  const io = makeIo(ioOverrides);
  const code = await run(args, io);
  return { code, out: io.out.text, err: io.err.text };
}

// Runs bin/relaylead.js in its own process.
function cliProcess(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: process.env, windowsHide: true });
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
    5000,
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
  await waitFor(() => pids.every((pid) => !isAlive(pid)), 5000, 'the sessions to end');

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
  await waitFor(() => !isAlive(lead.pid), 5000, 'the lead to be stopped');
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
