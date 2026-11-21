const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../core/cli');
const { askQuestion, answerQuestion, listQuestions } = require('../core/questions');
const { getState } = require('../core/missions');
const { listTasks } = require('../core/tasks');
const { waitForChanges } = require('../core/wait');
const { writeJsonExclusive, readJson, writeJson } = require('../core/store');
const { missionDir } = require('../core/paths');
const fake = require('../adapters/fake');
const { makeIo, waitFor, tmpDir } = require('../fixtures/helpers');
const { setupProject, writeMission, missionReport } = require('../fixtures/missions');

function demoMission(t) {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  return dir;
}

const QUESTION = { key: 'db', text: 'Which database?', context: 'for the API', options: ['sqlite', 'postgres'], recommended: 1 };

test('ask then answer', (t) => {
  demoMission(t);
  const { id, existing } = askQuestion('demo', QUESTION);
  assert.deepStrictEqual({ id, existing }, { id: 'q-db', existing: false });

  const [open] = listQuestions('demo', { state: 'open' });
  assert.strictEqual(open.id, 'q-db');
  assert.strictEqual(open.state, 'open');
  assert.deepStrictEqual(open.options, ['sqlite', 'postgres']);
  assert.strictEqual(open.recommended, 1);
  assert.ok(open.askedAt);

  answerQuestion('demo', id, 'postgres');
  assert.deepStrictEqual(listQuestions('demo', { state: 'open' }), []);
  const [answered] = listQuestions('demo', { state: 'answered' });
  assert.strictEqual(answered.state, 'answered');
  assert.strictEqual(answered.answer.choice, 'postgres');
  assert.ok(answered.answer.answeredAt);
  assert.throws(() => answerQuestion('demo', id, 'sqlite'), { code: 'question-answered' });
  assert.strictEqual(listQuestions('demo')[0].answer.choice, 'postgres');
});

test('asking twice with the same key returns the same question', (t) => {
  demoMission(t);
  const first = askQuestion('demo', QUESTION);
  const second = askQuestion('demo', { ...QUESTION, text: 'Another text' });
  assert.deepStrictEqual(second, { id: first.id, existing: true });
  answerQuestion('demo', first.id, '1');
  assert.deepStrictEqual(askQuestion('demo', QUESTION), { id: first.id, existing: true });
  const all = listQuestions('demo');
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].text, 'Which database?');
});

test('answer accepts the option number or its text', (t) => {
  demoMission(t);
  askQuestion('demo', QUESTION);
  askQuestion('demo', { ...QUESTION, key: 'cache' });
  answerQuestion('demo', 'q-db', '2');
  answerQuestion('demo', 'q-cache', 'SQLite');
  const byId = Object.fromEntries(listQuestions('demo').map((q) => [q.id, q.answer.choice]));
  assert.deepStrictEqual(byId, { 'q-db': 'postgres', 'q-cache': 'sqlite' });

  askQuestion('demo', { ...QUESTION, key: 'bad' });
  for (const choice of ['0', '3', 'mysql', '']) {
    assert.throws(() => answerQuestion('demo', 'q-bad', choice), (err) => {
      assert.strictEqual(err.code, 'bad-choice');
      assert.match(err.message, /sqlite/);
      assert.match(err.message, /postgres/);
      return true;
    });
  }
  assert.deepStrictEqual(listQuestions('demo', { state: 'open' }).map((q) => q.id), ['q-bad']);
});

test('answering an unknown question fails clearly', async (t) => {
  demoMission(t);
  assert.throws(() => answerQuestion('demo', 'q-nope', '1'), (err) => {
    assert.strictEqual(err.code, 'question-unknown');
    assert.match(err.message, /q-nope/);
    return true;
  });
  const io = makeIo();
  assert.strictEqual(await run(['answer', 'demo', 'q-nope', '1'], io), 1, io.err.text);
  assert.match(io.err.text, /q-nope/);
});

test('the question and answer commands ask, list and answer', async (t) => {
  demoMission(t);
  const io = makeIo({ env: { RELAYLEAD_MISSION: 'demo' } });
  const code = await run(
    ['question', 'ask', '--key', 'db', '--text', 'Which?', '--option', 'sqlite', '--option', 'postgres', '--recommended', '2'],
    io,
  );
  assert.strictEqual(code, 0, io.err.text);
  assert.strictEqual(io.out.text.trim(), 'q-db');

  const listed = makeIo();
  assert.strictEqual(await run(['question', 'list', 'demo'], listed), 0, listed.err.text);
  // The recommended option comes first, so the numbers a person sees are the numbers answer takes.
  assert.deepStrictEqual(JSON.parse(listed.out.text)[0].options, ['postgres', 'sqlite']);

  const answeredFirst = makeIo();
  assert.strictEqual(await run(['answer', 'demo', 'q-db', '1'], answeredFirst), 0, answeredFirst.err.text);
  const open = makeIo();
  await run(['question', 'list', 'demo'], open);
  assert.deepStrictEqual(JSON.parse(open.out.text), []);
  const all = makeIo();
  await run(['question', 'list', 'demo', '--all'], all);
  assert.strictEqual(JSON.parse(all.out.text)[0].answer.choice, 'postgres');
});

test('wait reports an answered question', async (t) => {
  demoMission(t);
  askQuestion('demo', QUESTION);
  const first = await waitForChanges('demo', 5);
  assert.deepStrictEqual(first.filter((c) => c.kind === 'question'), [{ kind: 'question', id: 'q-db', from: null, to: 'open' }]);
  answerQuestion('demo', 'q-db', '1');
  const second = await waitForChanges('demo', 5);
  assert.deepStrictEqual(second.filter((c) => c.kind === 'question'), [
    { kind: 'question', id: 'q-db', from: 'open', to: 'answered' },
  ]);
});

test('fake mission waits for the answer then finishes', async (t) => {
  const dir = setupProject(t, 'demo');
  fs.writeFileSync(path.join(dir, 'tasks', 'a.md'), '---\ntitle: First task\nask: Start the first task?\n---\n\nWrite it.\n');
  // The lead ends its turn while it waits for the answer, which wakes it by a targeted pass of the
  // watcher: RELAYLEAD_WATCHER is lifted for the test, and the machine config keeps the loop off.
  const watcherVar = process.env.RELAYLEAD_WATCHER;
  delete process.env.RELAYLEAD_WATCHER;
  t.after(() => {
    if (watcherVar !== undefined) process.env.RELAYLEAD_WATCHER = watcherVar;
  });
  const configFile = path.join(process.env.RELAYLEAD_HOME, 'config.json');
  writeJson(configFile, { ...readJson(configFile, {}), watcher: { autoStart: false } });

  const launched = makeIo();
  assert.strictEqual(await run(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir], launched), 0, launched.err.text);
  const report = () => missionReport('demo');
  await waitFor(() => listQuestions('demo').length === 1, 30000, 'the question to be asked', report);
  assert.strictEqual(listQuestions('demo')[0].key, 'a');
  // Unanswered: the task is not started and the mission is not done.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.strictEqual(listTasks('demo').find((task) => task.id === 'a').state, 'todo');
  assert.notStrictEqual(getState('demo'), 'done');

  // Answered once the lead has ended its turn: only the wake can take the mission further.
  await waitFor(
    async () => {
      const lead = readJson(path.join(missionDir('demo'), 'lead.json'), null);
      const row = lead && (await fake.list('demo')).find((one) => one.shortId === lead.shortId);
      return getState('demo') === 'waiting' && Boolean(row && row.pid && row.idle === true);
    },
    30000,
    'the lead to end its turn waiting for the answer',
    report,
  );
  const answered = makeIo();
  assert.strictEqual(await run(['answer', 'demo', 'q-a', 'yes'], answered), 0, answered.err.text);
  await waitFor(() => getState('demo') === 'done', 45000, 'the mission to be done', report);
  assert.deepStrictEqual(listTasks('demo').map((task) => task.state), ['delivered', 'delivered']);
  assert.strictEqual(listQuestions('demo').length, 1);
});

test('two keys that make the same id are refused, naming the existing question', (t) => {
  demoMission(t);
  askQuestion('demo', { ...QUESTION, key: 'A.b' });
  assert.deepStrictEqual(askQuestion('demo', { ...QUESTION, key: 'A.b' }), { id: 'q-a-b', existing: true });
  assert.throws(() => askQuestion('demo', { ...QUESTION, key: 'a-b' }), (err) => {
    assert.strictEqual(err.code, 'question-key-clash');
    assert.match(err.message, /q-a-b/);
    return true;
  });
  assert.strictEqual(listQuestions('demo').length, 1);
});

test('a key with no letter or digit is a coded error', (t) => {
  demoMission(t);
  assert.throws(() => askQuestion('demo', { ...QUESTION, key: '!!!' }), { code: 'bad-question' });
});

test('an option without a value is refused, and answer confirms', async (t) => {
  demoMission(t);
  const io = makeIo({ env: { RELAYLEAD_MISSION: 'demo' } });
  assert.strictEqual(await run(['question', 'ask', '--key', 'k', '--text', 'T', '--option', 'a', '--option'], io), 1, io.err.text);
  assert.match(io.err.text, /--option/);
  assert.strictEqual(listQuestions('demo').length, 0);

  askQuestion('demo', QUESTION);
  const answered = makeIo();
  assert.strictEqual(await run(['answer', 'demo', 'q-db', '2'], answered), 0, answered.err.text);
  assert.match(answered.out.text, /q-db.*postgres/);
});

test('writeJsonExclusive writes once and leaves no temporary file', (t) => {
  const dir = tmpDir('relaylead-store-');
  const file = path.join(dir, 'x.json');
  assert.strictEqual(writeJsonExclusive(file, { n: 1 }), true);
  assert.strictEqual(writeJsonExclusive(file, { n: 2 }), false);
  assert.deepStrictEqual(readJson(file), { n: 1 });
  assert.deepStrictEqual(fs.readdirSync(dir), ['x.json']);
});
