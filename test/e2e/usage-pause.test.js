// The pause of a mission at the usage limit, through the real CLI, with the fake agent, on a copy of
// fixtures/toy-repo: a usage measured past the threshold, then a usage limit hit. The watcher's passes
// are run by hand (`relaylead watcher run`): RELAYLEAD_WATCHER stays off, and the loop too.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { listSessions } = require('../../core/sessions');
const { readJson, writeJson } = require('../../core/store');
const { missionDir, home } = require('../../core/paths');
const { listTasks } = require('../../core/tasks');
const { usageFile } = require('../../core/usage');
const fake = require('../../adapters/fake');
const { tmpDir, waitFor, userEnv } = require('../../fixtures/helpers');
const { gitRepo } = require('../../fixtures/git');
const { missionReport } = require('../../fixtures/missions');

const BIN = path.join(__dirname, '..', '..', 'bin', 'relaylead.js');
const TOY_REPO = path.join(__dirname, '..', '..', 'fixtures', 'toy-repo');
const MISSION_MS = 60 * 1000;
const HOUR = 60 * 60 * 1000;

// Runs `relaylead <args>` in its own process, like a person in a terminal. No shell.
function relaylead(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env: userEnv(), windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function toyFiles() {
  const files = {};
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else files[path.relative(TOY_REPO, file).split(path.sep).join('/')] = fs.readFileSync(file, 'utf8');
    }
  };
  walk(TOY_REPO);
  return files;
}

// A fresh home whose machine config keeps the loop off, short delays, and `env` set for the test (the
// fake agents inherit it). Everything is put back afterwards, and every session of the missions is
// stopped.
function setup(t, env) {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  writeJson(path.join(home(), 'config.json'), { watcher: { autoStart: false } });
  const all = { RELAYLEAD_USAGE_PAUSE_GRACE_MS: '2000', RELAYLEAD_RESTART_GRACE_MS: '300', RELAYLEAD_LEAD_QUIET_MS: '300', ...env };
  const saved = {};
  for (const name of Object.keys(all)) saved[name] = process.env[name];
  Object.assign(process.env, all);
  const missions = [];
  t.after(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const mission of missions) for (const session of listSessions(mission)) await fake.stop(session);
  });
  return missions;
}

async function launch(missions, dir, ...options) {
  const launched = await relaylead(['launch', '--agent', 'fake', '--request', 'Do the tasks', ...options], dir);
  assert.strictEqual(launched.code, 0, launched.err);
  const mission = launched.out.trim();
  missions.push(mission);
  return mission;
}

function leadOf(mission) {
  return readJson(path.join(missionDir(mission), 'lead.json'), null);
}

function stateOf(mission) {
  return readJson(path.join(missionDir(mission), 'state.json'), {}).state;
}

function pauseFile(mission) {
  return path.join(missionDir(mission), 'usage-pause.json');
}

function watcherLog() {
  const file = path.join(home(), 'watcher.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

// The current lead, listed idle with its process.
async function leadIdle(mission) {
  const lead = leadOf(mission);
  const row = lead && (await fake.list(mission)).find((one) => one.shortId === lead.shortId);
  return Boolean(row && row.pid && row.idle === true);
}

// The lead waits for the answer to q-b, its turn ended.
async function waitsForAnswer(mission) {
  return fs.existsSync(path.join(missionDir(mission), 'questions', 'q-b.json')) && stateOf(mission) === 'waiting' && (await leadIdle(mission));
}

async function noSessionRuns(mission) {
  return (await fake.list(mission)).every((row) => !row.pid);
}

async function pass() {
  const result = await relaylead(['watcher', 'run'], home());
  assert.strictEqual(result.code, 0, result.err);
}

// Runs a pass every second until `done()` is true.
async function passUntil(done, what, report) {
  const end = Date.now() + MISSION_MS;
  while (!(await done())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${report()}`);
    await pass();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// The time to resume comes now: the test does not wait for the real one.
function resumeTimeHasCome(mission) {
  writeJson(pauseFile(mission), { ...readJson(pauseFile(mission)), resumeAt: new Date(Date.now() - 1000).toISOString() });
}

// Passes until the mission is done, answering q-b once its lead waits for it.
async function passUntilDone(mission, dir, report) {
  let answered = false;
  await passUntil(
    async () => {
      if (stateOf(mission) === 'done') return true;
      if (!answered && (await waitsForAnswer(mission))) {
        const reply = await relaylead(['answer', mission, 'q-b', '1'], dir);
        assert.strictEqual(reply.code, 0, reply.err);
        answered = true;
      }
      return false;
    },
    'the mission to be done',
    report,
  );
}

// Done without a task lost, and nothing left behind: no session runs, no lock is held.
async function assertDoneAndClean(mission, report) {
  for (const task of listTasks(mission)) assert.strictEqual(task.state, 'delivered', report());
  await waitFor(() => noSessionRuns(mission), MISSION_MS, 'the sessions of the done mission to end', report);
  assert.strictEqual(fs.existsSync(path.join(missionDir(mission), 'start.lock')), false, report());
  const locks = path.join(home(), 'locks');
  assert.deepStrictEqual(fs.existsSync(locks) ? fs.readdirSync(locks) : [], [], report());
  assert.strictEqual(fs.existsSync(pauseFile(mission)), false, report());
}

test('a mission past its usage threshold pauses, then resumes at its time and ends', { timeout: 4 * MISSION_MS }, async (t) => {
  // The fake agents write a usage of 90 % of the 5-hour window at each command.
  const missions = setup(t, { RELAYLEAD_FAKE_USAGE_FIVE_HOUR: '90' });
  const dir = gitRepo(toyFiles());
  const mission = await launch(missions, dir);
  const report = () => missionReport(mission) + '\n--- watcher.log\n' + watcherLog();

  // No pass has run yet: the mission goes on until its lead waits for the answer to q-b.
  await waitFor(() => waitsForAnswer(mission), MISSION_MS, 'the lead to wait for q-b', report);
  await passUntil(async () => fs.existsSync(pauseFile(mission)) && (await noSessionRuns(mission)), 'the pause to stop the sessions', report);
  assert.match(watcherLog(), new RegExp(`${mission} usage-pause until .*: five-hour 90% >= 85%`), report());
  const shown = await relaylead(['show', mission], dir);
  assert.match(shown.out, /usage-pause \(resume \d{4}-\d\d-\d\d \d\d:\d\d\)/, shown.err);
  // Nothing is relaunched while the pause lasts.
  const sessions = listSessions(mission).length;
  for (let i = 0; i < 3; i++) await pass();
  assert.strictEqual(listSessions(mission).length, sessions, report());
  assert.ok(await noSessionRuns(mission), report());

  // The usage is under the threshold again, and the time to resume has come.
  delete process.env.RELAYLEAD_FAKE_USAGE_FIVE_HOUR;
  writeJson(usageFile(), { claude: { at: new Date().toISOString(), fiveHour: { percent: 10, resetsAt: null }, sevenDay: null } });
  resumeTimeHasCome(mission);
  await passUntilDone(mission, dir, report);
  assert.match(watcherLog(), new RegExp(`${mission} usage-resumed`), report());
  await assertDoneAndClean(mission, report);
});

test('a usage limit hit pauses the mission until the time of its message, then it resumes and ends', { timeout: 4 * MISSION_MS }, async (t) => {
  const missions = setup(t, { RELAYLEAD_FAKE_RATE_LIMIT: '1' });
  const dir = gitRepo(toyFiles());
  const mission = await launch(missions, dir);
  const report = () => missionReport(mission) + '\n--- watcher.log\n' + watcherLog();
  const lead = leadOf(mission);
  await waitFor(() => fs.existsSync(path.join(missionDir(mission), 'failures', `${lead.shortId}.json`)), MISSION_MS, 'the usage limit', report);

  // The message says the limit resets in an hour, to the minute.
  const pausedAt = Date.now();
  await passUntil(async () => fs.existsSync(pauseFile(mission)) && (await noSessionRuns(mission)), 'the pause to stop the lead', report);
  const resumeAt = Date.parse(readJson(pauseFile(mission)).resumeAt);
  assert.ok(resumeAt > pausedAt + HOUR - 2 * 60 * 1000 && resumeAt <= pausedAt + HOUR, report());

  delete process.env.RELAYLEAD_FAKE_RATE_LIMIT;
  resumeTimeHasCome(mission);
  await passUntilDone(mission, dir, report);
  assert.notStrictEqual(leadOf(mission).shortId, lead.shortId);
  await assertDoneAndClean(mission, report);
});

test('at 80 % of the 5-hour window, a low mission pauses and a normal one goes on', { timeout: 2 * MISSION_MS }, async (t) => {
  const missions = setup(t, { RELAYLEAD_FAKE_END_FIRST_TURN: '1' });
  const low = await launch(missions, gitRepo(toyFiles()), '--name', 'low', '--priority', 'low');
  const normal = await launch(missions, gitRepo(toyFiles()), '--name', 'normal');
  writeJson(usageFile(), { claude: { at: new Date().toISOString(), fiveHour: { percent: 80, resetsAt: new Date(Date.now() + HOUR).toISOString() }, sevenDay: null } });

  await pass();
  assert.strictEqual(fs.existsSync(pauseFile(low)), true, watcherLog());
  assert.strictEqual(fs.existsSync(pauseFile(normal)), false, watcherLog());
  for (const mission of missions) assert.strictEqual((await relaylead(['stop', mission], home())).code, 0);
});
