const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const watcher = require('../core/watcher');
const { run } = require('../core/cli');
const { t: msg } = require('../core/messages');
const { home, missionDir } = require('../core/paths');
const { writeJson, readJson } = require('../core/store');
const { recordSession } = require('../core/sessions');
const { tmpDir, makeIo, waitFor, userEnv } = require('../fixtures/helpers');
const { writeMission } = require('../fixtures/missions');

const BIN = path.join(__dirname, '..', 'bin', 'relaylead.js');
// A pid no process has: the current lead of a mission, listed failed by the fake agent.
const DEAD_PID = 2147483646;

function loopFile() {
  return path.join(home(), 'watcher-loop.json');
}

function loopStopFile() {
  return path.join(home(), 'watcher-loop.stop');
}

function readLoop() {
  return readJson(loopFile(), null);
}

function logText() {
  try {
    return fs.readFileSync(path.join(home(), 'watcher.log'), 'utf8');
  } catch {
    return '';
  }
}

async function cli(...args) {
  const io = makeIo();
  const code = await run(args, io);
  return { code, out: io.out.text, err: io.err.text };
}

function explain() {
  return `watcher-loop.json: ${JSON.stringify(readLoop())}\nwatcher.log:\n${logText()}`;
}

// A fresh RELAYLEAD_HOME whose loop passes every second, RELAYLEAD_WATCHER removed for the test.
// Afterwards, the watcher is stopped and every loop the test started directly has exited.
function loopHome(t) {
  const dir = tmpDir('relaylead-home-');
  process.env.RELAYLEAD_HOME = dir;
  writeJson(path.join(dir, 'config.json'), { delivery: { type: 'files' }, watcher: { everySeconds: 1 } });
  const saved = process.env.RELAYLEAD_WATCHER;
  delete process.env.RELAYLEAD_WATCHER;
  const loops = [];
  t.after(async () => {
    process.env.RELAYLEAD_HOME = dir;
    await watcher.stopWatcher();
    await Promise.all(loops.map((loop) => loop.exited));
    if (saved === undefined) delete process.env.RELAYLEAD_WATCHER;
    else process.env.RELAYLEAD_WATCHER = saved;
  });
  return loops;
}

// A mission to watch: mission.json, no lead yet (a mission being launched), a project without tasks.
function missionToWatch(name = 'demo') {
  const dir = tmpDir('relaylead-project-');
  fs.mkdirSync(path.join(dir, 'tasks'));
  writeMission(name, dir);
}

// `relaylead watcher loop` started by the test, which sees it exit (never judged on its pid).
function spawnLoop(loops) {
  const child = spawn(process.execPath, [BIN, 'watcher', 'loop'], { env: userEnv(), stdio: 'ignore', windowsHide: true });
  const loop = { child, ended: false };
  loop.exited = new Promise((resolve) => {
    child.once('exit', () => {
      loop.ended = true;
      resolve();
    });
    child.once('error', resolve);
  });
  loops.push(loop);
  return loop;
}

// The next lastPassAt after `after` (null: the first one).
async function nextPass(after) {
  let pass = null;
  await waitFor(
    () => {
      const loop = readLoop();
      pass = loop && loop.lastPassAt;
      return Boolean(pass) && pass !== after;
    },
    10000,
    'a pass of the loop',
    explain,
  );
  return pass;
}

test('watcher start runs passes until stopped, and status says so', async (t) => {
  loopHome(t);
  missionToWatch();

  const started = await cli('watcher', 'start');
  assert.strictEqual(started.code, 0, started.err);
  assert.strictEqual(started.out, msg('watcherStarted', { seconds: 1 }));

  const first = await nextPass(null);
  const second = await nextPass(first);
  assert.ok(second > first);
  const loop = readLoop();
  assert.strictEqual(loop.everySeconds, 1);
  assert.strictEqual(loop.version, require('../package.json').version);
  const status = await cli('watcher', 'status');
  assert.strictEqual(status.out, msg('watcherStatusRunning', { since: loop.startedAt, lastPass: readLoop().lastPassAt }));

  const stopped = await cli('watcher', 'stop');
  assert.strictEqual(stopped.code, 0, stopped.err);
  assert.strictEqual(stopped.out, msg('watcherStopped', {}));
  assert.strictEqual(fs.existsSync(loopFile()), false);
  assert.strictEqual(fs.existsSync(loopStopFile()), true);
  assert.strictEqual((await cli('watcher', 'status')).out, msg('watcherNotRunning', {}));
});

test('a stop holds until the next start', async (t) => {
  loopHome(t);
  missionToWatch();
  assert.strictEqual(await watcher.startWatcher(), 'started');
  assert.strictEqual(await watcher.stopWatcher(), 'stopped');

  assert.strictEqual(await watcher.startWatcher({ unlessStopped: true }), 'stopped-by-user');
  assert.strictEqual(fs.existsSync(loopFile()), false);
  assert.strictEqual(watcher.watcherRunning().running, false);

  assert.strictEqual(await watcher.startWatcher(), 'started');
  assert.strictEqual(fs.existsSync(loopStopFile()), false);
  assert.strictEqual(watcher.watcherRunning().running, true);
});

test('a second start finds the watcher running', async (t) => {
  loopHome(t);
  missionToWatch();
  assert.strictEqual(await watcher.startWatcher(), 'started');
  const { startedAt, pid } = readLoop();

  const again = await cli('watcher', 'start');
  assert.strictEqual(again.out, msg('watcherAlreadyRunning', { since: startedAt }));
  assert.strictEqual(await watcher.startWatcher({ unlessStopped: true }), 'already');
  assert.strictEqual(readLoop().pid, pid);
});

test('two loops started at once leave one', async (t) => {
  const loops = loopHome(t);
  missionToWatch();
  const both = [spawnLoop(loops), spawnLoop(loops)];

  await new Promise((resolve) => setTimeout(resolve, 3000));
  const running = both.filter((loop) => !loop.ended);
  assert.strictEqual(running.length, 1, explain());
  assert.strictEqual(readLoop().pid, running[0].child.pid);
});

test('stop leaves no loop running', async (t) => {
  loopHome(t);
  const savedWait = process.env.RELAYLEAD_STOP_WAIT_MS;
  process.env.RELAYLEAD_STOP_WAIT_MS = '200';
  t.after(() => {
    if (savedWait === undefined) delete process.env.RELAYLEAD_STOP_WAIT_MS;
    else process.env.RELAYLEAD_STOP_WAIT_MS = savedWait;
  });
  // A mission held with an extra lead that does not end: its process is this test's, alive
  // throughout. Each pass tries to stop it and writes a line.
  missionToWatch();
  const record = (name, pid) => {
    const hex = crypto.randomBytes(8).toString('hex');
    const session = { sessionId: `fake-${hex}`, shortId: hex.slice(0, 8), name, role: 'lead', pid, cwd: tmpDir('relaylead-cwd-') };
    recordSession('demo', session);
    return session;
  };
  const current = record('demo/lead/1', DEAD_PID);
  record('demo/lead/9', process.pid);
  writeJson(path.join(missionDir('demo'), 'lead.json'), {
    sessionId: current.sessionId,
    shortId: current.shortId,
    sessionName: current.name,
    startedAt: new Date().toISOString(),
  });

  assert.strictEqual(await watcher.startWatcher(), 'started');
  await waitFor(() => (logText().match(/stop-extra-lead/g) || []).length >= 2, 15000, 'two passes on the extra lead', explain);
  assert.strictEqual((await cli('watcher', 'stop')).out, msg('watcherStopped', {}));

  const log = logText();
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    assert.strictEqual(fs.existsSync(loopFile()), false, explain());
    assert.strictEqual(logText(), log);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

test('a stale stop file does not kill a new loop', async (t) => {
  loopHome(t);
  missionToWatch();
  fs.writeFileSync(loopStopFile(), '');

  assert.strictEqual(await watcher.startWatcher(), 'started');
  const first = await nextPass(null);
  await nextPass(first);
  assert.strictEqual(watcher.watcherRunning().running, true);
});

test('the loop ends by itself once no mission needs watching', async (t) => {
  const loops = loopHome(t);
  missionToWatch();
  const loop = spawnLoop(loops);
  await nextPass(null);

  writeJson(path.join(missionDir('demo'), 'state.json'), { state: 'stopped', at: new Date().toISOString() });
  await waitFor(() => loop.ended, 10000, 'the loop to end', explain);
  assert.strictEqual(fs.existsSync(loopFile()), false);
});

test('the loop keeps running while STOP is present', async (t) => {
  const loops = loopHome(t);
  missionToWatch();
  fs.writeFileSync(path.join(home(), 'STOP'), '');
  const loop = spawnLoop(loops);

  const first = await nextPass(null);
  await nextPass(first);
  assert.strictEqual(loop.ended, false);
  assert.strictEqual(watcher.watcherRunning().running, true);
});

test('start with no mission to watch starts nothing', async (t) => {
  loopHome(t);
  assert.strictEqual((await cli('watcher', 'start')).out, msg('watcherNothingToWatch', {}));

  missionToWatch();
  writeJson(path.join(missionDir('demo'), 'state.json'), { state: 'done', at: new Date().toISOString() });
  assert.strictEqual(await watcher.startWatcher(), 'nothing');
  assert.strictEqual(fs.existsSync(loopFile()), false);
  assert.strictEqual((await cli('watcher', 'stop')).out, msg('watcherNotRunning', {}));
});

test('a loop beat older than 90 s is not a running watcher', async (t) => {
  loopHome(t);
  missionToWatch();
  const beat = (ago) => {
    const at = new Date(Date.now() - ago).toISOString();
    writeJson(loopFile(), { pid: DEAD_PID, startedAt: at, version: '0.0.0', beatAt: at, lastPassAt: null, everySeconds: 1 });
  };

  beat(60 * 1000);
  assert.strictEqual(watcher.watcherRunning().running, true);
  beat(91 * 1000);
  assert.deepStrictEqual(watcher.watcherRunning(), { running: false, since: null, lastPassAt: null });
  assert.strictEqual((await cli('watcher', 'status')).out, msg('watcherNotRunning', {}));

  assert.strictEqual(await watcher.startWatcher(), 'started');
  assert.notStrictEqual(readLoop().pid, DEAD_PID);
});

test('the loop ends when the package version changes', async (t) => {
  const loops = loopHome(t);
  missionToWatch();
  const loop = spawnLoop(loops);
  await nextPass(null);

  writeJson(loopFile(), { ...readLoop(), version: '0.0.0' });
  await waitFor(() => loop.ended, 10000, 'the loop to end', explain);
  assert.strictEqual(fs.existsSync(loopFile()), false);
});

test('a loop started by the tests ends once their run is over', async (t) => {
  const loops = loopHome(t);
  missionToWatch();
  const runFile = path.join(tmpDir('relaylead-run-'), 'running');
  fs.writeFileSync(runFile, '');
  const saved = process.env.RELAYLEAD_TEST_RUN_FILE;
  process.env.RELAYLEAD_TEST_RUN_FILE = runFile;
  t.after(() => {
    process.env.RELAYLEAD_TEST_RUN_FILE = saved;
  });
  const loop = spawnLoop(loops);
  await nextPass(null);

  fs.rmSync(runFile);
  await waitFor(() => loop.ended, 10000, 'the loop to end', explain);
  assert.strictEqual(fs.existsSync(loopFile()), false);
});
