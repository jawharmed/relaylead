// The human in the loop, through the real CLI and the fake agent: commands refused by the hooks become
// questions to the user, the rest of the mission goes on, and the user's answers let them through.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { listSessions } = require('../../core/sessions');
const fake = require('../../adapters/fake');
const { tmpDir, waitFor, userEnv } = require('../../fixtures/helpers');
const { gitRepo } = require('../../fixtures/git');
const { missionReport } = require('../../fixtures/missions');

const BIN = path.join(__dirname, '..', '..', 'bin', 'relaylead.js');
const MISSION_MS = 60 * 1000;
const OUT_OF_LIST = 'make deploy';
const IRREVERSIBLE = 'git reset --hard';

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

async function json(args, cwd) {
  const result = await relaylead(args, cwd);
  assert.strictEqual(result.code, 0, result.err);
  return JSON.parse(result.out);
}

// A fresh home, the notifications written down by the script of fixtures/, and the commands the
// tasks try (RELAYLEAD_FAKE_TRY), all in process.env: the fake agents and their hooks inherit it.
// Returns a function giving the notifications received so far.
function setUp(t, env) {
  const names = ['RELAYLEAD_HOME', 'RELAYLEAD_NOTIFY', 'RELAYLEAD_NOTIFY_BIN', 'RELAYLEAD_NOTIFY_LOG', ...Object.keys(env)];
  const saved = names.map((name) => [name, process.env[name]]);
  const log = path.join(tmpDir(), 'notifications.log');
  Object.assign(process.env, {
    RELAYLEAD_HOME: tmpDir('relaylead-home-'),
    RELAYLEAD_NOTIFY_BIN: path.join(__dirname, '..', '..', 'fixtures', 'notify-bin.js'),
    RELAYLEAD_NOTIFY_LOG: log,
    ...env,
  });
  delete process.env.RELAYLEAD_NOTIFY;
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  return () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
}

// Launches a mission with the fake agent in a repository holding `tasks` ({id: front matter lines})
// and `config` as its .relaylead.json; its sessions are stopped after the test.
async function launch(t, tasks, config) {
  const files = { '.relaylead.json': JSON.stringify(config) };
  for (const [id, fields] of Object.entries(tasks)) files[`tasks/${id}.md`] = `---\n${fields}\n---\n\nWrite ${id}.\n`;
  const dir = gitRepo(files);
  let mission = null;
  // The home of this test: setUp's own cleanup may already have put the former one back.
  const home = process.env.RELAYLEAD_HOME;
  t.after(async () => {
    const current = process.env.RELAYLEAD_HOME;
    process.env.RELAYLEAD_HOME = home;
    try {
      if (mission) for (const session of listSessions(mission)) await fake.stop(session);
    } finally {
      process.env.RELAYLEAD_HOME = current;
    }
  });
  const launched = await relaylead(['launch', '--agent', 'fake', '--request', 'Do the tasks'], dir);
  assert.strictEqual(launched.code, 0, launched.err);
  mission = launched.out.trim();
  return { dir, mission, report: () => missionReport(mission) };
}

function byId(list) {
  return Object.fromEntries(list.map((item) => [item.id, item]));
}

test('refused commands become questions, the mission goes on, and the answers let them through', { timeout: 3 * MISSION_MS }, async (t) => {
  const notifications = setUp(t, { RELAYLEAD_FAKE_TRY: JSON.stringify({ a: OUT_OF_LIST, b: IRREVERSIBLE }) });
  const tasks = { a: 'title: Out of the list', b: 'title: Irreversible', c: 'title: Independent' };
  const { dir, mission, report } = await launch(t, tasks, { guard: { allow: ['Bash(git *)'] } });
  const mine = ['--mission', mission];

  // Two questions open, two notifications, and the independent task delivered meanwhile.
  let questions = {};
  await waitFor(
    async () => {
      questions = byId(await json(['question', 'list', mission], dir));
      const list = byId(await json(['task', 'list', ...mine], dir));
      return Object.keys(questions).length === 2 && list.c && list.c.state === 'delivered';
    },
    MISSION_MS,
    'two questions and task c delivered',
    report,
  );
  const perm = Object.values(questions).find((question) => question.kind === 'permission');
  const irr = Object.values(questions).find((question) => question.kind === 'irreversible');
  assert.deepStrictEqual([perm.text, irr.text], [OUT_OF_LIST, IRREVERSIBLE], report());
  await waitFor(() => notifications().length === 2, 5000, 'two notifications', report);
  const shown = notifications().join('\n');
  assert.match(shown, new RegExp(`Question ${perm.id}: ${OUT_OF_LIST}`));
  assert.match(shown, new RegExp(`Question ${irr.id}: ${IRREVERSIBLE}`));

  // The user answers, then retries both tasks: both are delivered.
  for (const [id, choice] of [[perm.id, 'Always allow in this mission'], [irr.id, 'Allow once']]) {
    const answered = await relaylead(['answer', mission, id, choice], dir);
    assert.strictEqual(answered.code, 0, answered.err);
  }
  for (const id of ['a', 'b']) {
    const retried = await relaylead(['task', 'retry', id, ...mine], dir);
    assert.strictEqual(retried.code, 0, retried.err);
  }
  await waitFor(
    async () => (await relaylead(['state', 'get', ...mine], dir)).out.trim() === 'done',
    MISSION_MS,
    'the mission to be done',
    report,
  );
  const list = await json(['task', 'list', ...mine], dir);
  assert.deepStrictEqual(list.map((task) => [task.id, task.state]), [['a', 'delivered'], ['b', 'delivered'], ['c', 'delivered']], report());
});

test('onTimeout recommended answers a lead question, never a permission one', { timeout: 3 * MISSION_MS }, async (t) => {
  setUp(t, { RELAYLEAD_FAKE_TRY: JSON.stringify({ a: OUT_OF_LIST }), RELAYLEAD_QUESTION_TIMEOUT_MS: '1' });
  const tasks = { a: 'title: Out of the list', b: 'title: Asks first\nask: Should b be written?' };
  const { dir, mission, report } = await launch(t, tasks, { questions: { onTimeout: 'recommended' } });

  await waitFor(
    async () => Object.keys(byId(await json(['question', 'list', mission], dir))).length === 2,
    MISSION_MS,
    'two questions',
    report,
  );
  const pass = await relaylead(['watcher', 'run', '--mission', mission], dir);
  assert.strictEqual(pass.code, 0, pass.err);
  const questions = byId(await json(['question', 'list', mission, '--all'], dir));
  const perm = Object.values(questions).find((question) => question.kind === 'permission');
  assert.strictEqual(perm.state, 'open', report());
  assert.deepStrictEqual([questions['q-b'].state, questions['q-b'].answer.choice], ['answered', 'yes'], report());
});
