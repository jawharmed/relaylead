const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { run } = require('../core/cli');
const { listMissions, stopMission, lockFile } = require('../core/missions');
const { listSessions, recordSession, isAlive } = require('../core/sessions');
const { readJson, writeJson } = require('../core/store');
const { missionDir } = require('../core/paths');
const fake = require('../adapters/fake');
const { tmpDir, makeIo, waitFor } = require('../fixtures/helpers');

const BIN = path.join(__dirname, '..', 'bin', 'relaylead.js');

// Each test gets a fresh RELAYLEAD_HOME, and every mission still running is stopped afterwards.
function freshHome(t) {
  const home = tmpDir('relaylead-home-');
  process.env.RELAYLEAD_HOME = home;
  t.after(async () => {
    process.env.RELAYLEAD_HOME = home;
    for (const mission of listMissions()) await stopMission(mission.name);
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
  assert.strictEqual(mission.dir, fs.realpathSync(dir));
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
  const lock = lockFile(fs.realpathSync(dir));
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
  assert.strictEqual(readJson(path.join(missionDir('my-project'), 'mission.json')).dir, fs.realpathSync(dir));
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
  assert.strictEqual(fs.existsSync(lockFile(fs.realpathSync(dir))), false);
  const refused = await cli(['state', 'set', 'working'], { env: { RELAYLEAD_MISSION: 'demo' } });
  assert.strictEqual(refused.code, 1);
  assert.match(refused.err, /stopped/);
});
