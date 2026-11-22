// The continuity of a mission through the real CLI, with the fake agent, on a copy of fixtures/toy-repo:
// a lead that ends its turn and is woken, a lead killed and relaunched, a lead that hands over.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { listSessions } = require('../../core/sessions');
const { readJson, writeJson } = require('../../core/store');
const { missionDir, home } = require('../../core/paths');
const { listTasks } = require('../../core/tasks');
const fake = require('../../adapters/fake');
const { tmpDir, waitFor, userEnv, killSession } = require('../../fixtures/helpers');
const { git, gitRepo } = require('../../fixtures/git');
const { missionReport } = require('../../fixtures/missions');

const BIN = path.join(__dirname, '..', '..', 'bin', 'relaylead.js');
const TOY_REPO = path.join(__dirname, '..', '..', 'fixtures', 'toy-repo');
const MISSION_MS = 60 * 1000;

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

// A fresh home whose machine config keeps the loop off, RELAYLEAD_WATCHER lifted (the targeted passes
// run), and `env` set for the test (the fake agents inherit it). Everything is put back afterwards,
// and every session of the missions is stopped.
function setup(t, env) {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  writeJson(path.join(home(), 'config.json'), { watcher: { autoStart: false } });
  const saved = {};
  for (const name of ['RELAYLEAD_WATCHER', ...Object.keys(env)]) saved[name] = process.env[name];
  delete process.env.RELAYLEAD_WATCHER;
  Object.assign(process.env, env);
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

async function launch(t, missions, dir) {
  const launched = await relaylead(['launch', '--agent', 'fake', '--request', 'Do the tasks'], dir);
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

// The current lead, listed idle with its process.
async function leadIdle(mission) {
  const lead = leadOf(mission);
  if (!lead) return false;
  const row = (await fake.list(mission)).find((one) => one.shortId === lead.shortId);
  return Boolean(row && row.pid && row.idle === true);
}

// The lines of the current lead's log that start a woken turn.
function wokenLines(mission) {
  const lead = leadOf(mission);
  const file = path.join(missionDir(mission), `fake-lead-${lead.shortId}.log`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.includes(' woken: ')) : [];
}

// Answers q-b once the lead has ended its turn waiting for it.
async function answerWhenIdle(mission, dir) {
  await waitFor(
    async () => fs.existsSync(path.join(missionDir(mission), 'questions', 'q-b.json')) && stateOf(mission) === 'waiting' && (await leadIdle(mission)),
    MISSION_MS,
    'the lead to wait for the answer to q-b',
    () => missionReport(mission),
  );
  const answered = await relaylead(['answer', mission, 'q-b', '1'], dir);
  assert.strictEqual(answered.code, 0, answered.err);
}

// Each task ran once: attempt 1, one crew session.
function assertEachTaskOnce(mission) {
  const crew = listSessions(mission).filter((session) => session.role === 'crew');
  for (const task of listTasks(mission)) {
    assert.strictEqual(task.state, 'delivered', missionReport(mission));
    assert.strictEqual(task.attempt, 1, missionReport(mission));
    // The fake agent keeps the env of each session in its record.
    assert.strictEqual(crew.filter((session) => session.env.RELAYLEAD_TASK === task.id).length, 1, missionReport(mission));
  }
}

test('an idle lead is woken when a crew member finishes', { timeout: 3 * MISSION_MS }, async (t) => {
  const gate = tmpDir('relaylead-gate-');
  const missions = setup(t, { RELAYLEAD_FAKE_LEAD_ENDS_TURN: '1', RELAYLEAD_FAKE_CREW_GATE: gate, RELAYLEAD_LEAD_QUIET_MS: '300' });
  const dir = gitRepo(toyFiles());
  const mission = await launch(t, missions, dir);
  const report = () => missionReport(mission);
  const waitingIdle = async (woken) => stateOf(mission) === 'waiting' && (await leadIdle(mission)) && wokenLines(mission).length === woken;

  await waitFor(() => waitingIdle(0), MISSION_MS, 'the lead to end its turn while a runs', report);
  fs.writeFileSync(path.join(gate, 'a'), '');
  await waitFor(() => wokenLines(mission).length === 1, MISSION_MS, 'the lead to be woken by the end of a', report);
  await answerWhenIdle(mission, dir);
  await waitFor(
    async () => (await waitingIdle(2)) && listTasks(mission).some((task) => task.id === 'b' && task.state === 'running'),
    MISSION_MS,
    'the lead to end its turn while b runs',
    report,
  );
  fs.writeFileSync(path.join(gate, 'b'), '');
  await waitFor(() => stateOf(mission) === 'done', MISSION_MS, 'the mission to be done', report);

  const woken = wokenLines(mission);
  assert.strictEqual(woken.length, 3, report());
  assert.match(woken[0], /task a is now done/);
  assert.match(woken[1], /question q-b is now answered/);
  assert.match(woken[2], /task b is now done/);
  assertEachTaskOnce(mission);
});


// Runs `relaylead watcher run` every second until `done()` is true.
async function passUntil(done, what, report) {
  const end = Date.now() + MISSION_MS;
  while (!(await done())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${report()}`);
    const pass = await relaylead(['watcher', 'run'], home());
    assert.strictEqual(pass.code, 0, pass.err);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function watcherLog() {
  const file = path.join(home(), 'watcher.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

test('a lead killed in the middle of a mission is resumed and the mission ends without loss', { timeout: 3 * MISSION_MS }, async (t) => {
  const gate = tmpDir('relaylead-gate-');
  const missions = setup(t, { RELAYLEAD_FAKE_CREW_GATE: gate, RELAYLEAD_RESTART_GRACE_MS: '300', RELAYLEAD_LEAD_QUIET_MS: '300' });
  const dir = gitRepo(toyFiles());
  const mission = await launch(t, missions, dir);
  const report = () => missionReport(mission) + '\n--- watcher.log\n' + watcherLog();

  await waitFor(() => listTasks(mission).some((task) => task.id === 'a' && task.state === 'running'), MISSION_MS, 'a to run', report);
  const lead = listSessions(mission).find((session) => session.shortId === leadOf(mission).shortId);
  killSession(lead);
  await passUntil(() => / relaunch-lead /.test(watcherLog()), 'the lead to be relaunched', report);
  assert.match(watcherLog(), new RegExp(`relaunch-lead ${lead.shortId} resumed`), report());
  fs.writeFileSync(path.join(gate, 'a'), '');
  fs.writeFileSync(path.join(gate, 'b'), '');
  await answerWhenIdle(mission, dir);
  await waitFor(() => stateOf(mission) === 'done', MISSION_MS, 'the mission to be done', report);

  assert.strictEqual(leadOf(mission).sessionName, `${mission}/lead/1`);
  assertEachTaskOnce(mission);
  for (const id of ['a', 'b']) assert.strictEqual(git(dir, 'show', `relaylead/${mission}/integration:${id}.txt`), `fake work on ${id}`);
});

test('a lead past a low threshold hands over and the mission ends without loss', { timeout: 3 * MISSION_MS }, async (t) => {
  const missions = setup(t, {
    RELAYLEAD_FAKE_TOKENS_PER_COMMAND: '1000',
    RELAYLEAD_LEAD_QUIET_MS: '300',
    RELAYLEAD_RESTART_GRACE_MS: '300',
  });
  const dir = gitRepo({ ...toyFiles(), '.relaylead.json': JSON.stringify({ context: { budgets: { lead: 6000 } } }) });
  const mission = await launch(t, missions, dir);
  const report = () => missionReport(mission) + '\n--- watcher.log\n' + watcherLog();

  let answered = false;
  await passUntil(
    async () => {
      if (stateOf(mission) === 'done') return true;
      const question = readJson(path.join(missionDir(mission), 'questions', 'q-b.json'), null);
      if (!answered && question && stateOf(mission) === 'waiting' && (await leadIdle(mission))) {
        const reply = await relaylead(['answer', mission, 'q-b', '1'], dir);
        assert.strictEqual(reply.code, 0, reply.err);
        answered = true;
      }
      return false;
    },
    'the mission to be done',
    report,
  );

  const leads = listSessions(mission).filter((session) => session.role === 'lead');
  assert.ok(leads.some((session) => session.name === `${mission}/lead/2`), report());
  assert.match(watcherLog(), / hand-over /);
  const current = leadOf(mission).shortId;
  const rows = await fake.list(mission);
  for (const old of leads.filter((session) => session.shortId !== current)) {
    assert.ok(!rows.find((row) => row.shortId === old.shortId).pid, `${old.name} still runs\n${report()}`);
  }
  assertEachTaskOnce(mission);
  for (const id of ['a', 'b']) assert.strictEqual(git(dir, 'show', `relaylead/${mission}/integration:${id}.txt`), `fake work on ${id}`);
});
