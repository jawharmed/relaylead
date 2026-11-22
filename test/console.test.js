// What the console (the Claude Code conversation) needs of the CLI: `tell` reaches the lead and stays
// in the mission, a question asked while no console runs is found, `wait --all` names the mission of
// each event, and the lead notes its decisions.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const watcher = require('../core/watcher');
const { run } = require('../core/cli');
const { missionDir } = require('../core/paths');
const { writeJson } = require('../core/store');
const { recordSession } = require('../core/sessions');
const { askQuestion, answerQuestion } = require('../core/questions');
const fake = require('../adapters/fake');
const { tmpDir, makeIo } = require('../fixtures/helpers');
const { setupProject, writeMission } = require('../fixtures/missions');

const DEAD_PID = 2147483646;

async function relaylead(args, env = {}) {
  const io = makeIo({ env });
  const code = await run(args, io);
  return { code, out: io.out.text, err: io.err.text };
}

// A second mission next to demo, without tasks.
function otherMission(name) {
  const dir = tmpDir('relaylead-project-');
  fs.mkdirSync(path.join(dir, 'tasks'));
  writeMission(name, dir);
  writeJson(path.join(missionDir(name), 'state.json'), { state: 'working', updatedAt: new Date().toISOString() });
}

async function waitAll() {
  const result = await relaylead(['wait', '--all', '--timeout', '0', '--json']);
  assert.strictEqual(result.code, 0, result.err);
  return JSON.parse(result.out).events;
}

test('tell is kept in the mission and reaches the lead, woken for it', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  writeJson(path.join(missionDir('demo'), 'state.json'), { state: 'waiting' });
  const lead = { sessionId: 'fake-aaaa', shortId: 'aaaa1111', name: 'demo/lead/1', role: 'lead', pid: DEAD_PID, cwd: dir };
  recordSession('demo', lead);
  writeJson(path.join(missionDir('demo'), 'lead.json'), {
    sessionId: lead.sessionId,
    shortId: lead.shortId,
    sessionName: lead.name,
    startedAt: new Date().toISOString(),
  });
  const woken = [];
  const { list, wake } = fake;
  fake.list = async () => [{ ...lead, state: 'waiting', idle: true }];
  fake.wake = async (session, message) => {
    woken.push(message);
    return session;
  };
  t.after(() => {
    fake.list = list;
    fake.wake = wake;
  });
  // The lead has seen the mission as it is.
  writeJson(path.join(missionDir('demo'), 'wait-snapshot.json'), { tasks: { a: 'todo', b: 'todo' }, questions: {}, lostSince: {} });

  const told = await relaylead(['tell', 'demo', 'Use', 'the', 'v2', 'API']);
  assert.strictEqual(told.code, 0, told.err);
  assert.match(told.out, /m-000001/);
  // One file per message, kept in the mission.
  const kept = JSON.parse(fs.readFileSync(path.join(missionDir('demo'), 'told', '000001.json'), 'utf8'));
  assert.strictEqual(kept.text, 'Use the v2 API');

  assert.deepStrictEqual((await watcher.tendMission('demo')).map((action) => action.type), ['wake-lead']);
  assert.strictEqual(woken.length, 1);
  assert.match(woken[0], /the user told you something \(m-000001\).*relaylead wait --timeout 0/);

  // The woken lead reads it, with its text, once.
  const first = await relaylead(['wait', '--timeout', '0'], { RELAYLEAD_MISSION: 'demo' });
  assert.deepStrictEqual(JSON.parse(first.out).changes, [{ kind: 'message', id: 'm-000001', from: null, to: 'sent', text: 'Use the v2 API' }]);
  const second = await relaylead(['wait', '--timeout', '0'], { RELAYLEAD_MISSION: 'demo' });
  assert.deepStrictEqual(JSON.parse(second.out).changes, []);
  assert.ok(fs.existsSync(path.join(missionDir('demo'), 'told', '000001.json')));
});

test('tell is refused to a session, to an unknown or a finished mission, and without text', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  assert.match((await relaylead(['tell', 'demo', 'x'], { RELAYLEAD_MISSION: 'demo' })).err, /belongs to the user/);
  assert.match((await relaylead(['tell', 'nope', 'x'])).err, /nope/);
  assert.strictEqual((await relaylead(['tell', 'demo'])).code, 1);
  writeJson(path.join(missionDir('demo'), 'state.json'), { state: 'done' });
  const over = await relaylead(['tell', 'demo', 'x']);
  assert.strictEqual(over.code, 1);
  assert.match(over.err, /is over/);
  assert.ok(!fs.existsSync(path.join(missionDir('demo'), 'told')));
});

test('a question asked while no console runs is found by the next wait --all, and by the list', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  writeJson(path.join(missionDir('demo'), 'state.json'), { state: 'waiting' });
  askQuestion('demo', { key: 'db', text: 'Which database?', options: ['Postgres', 'SQLite'], recommended: 1 });

  const events = await waitAll();
  assert.strictEqual(events.length, 1);
  assert.deepStrictEqual(events[0], {
    mission: 'demo',
    kind: 'question',
    id: 'q-db',
    state: 'open',
    question: { text: 'Which database?', context: null, options: ['Postgres', 'SQLite'], recommended: 1 },
  });
  assert.deepStrictEqual(await waitAll(), []);
  // Still open, so still found by a new conversation.
  assert.match((await relaylead(['question', 'list', 'demo'])).out, /q-db/);
});

test('wait --all names the mission of each event, and ignores the answer of the user', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  writeJson(path.join(missionDir('demo'), 'state.json'), { state: 'working' });
  otherMission('other');
  // A mission already over before the first wait is not news.
  otherMission('old');
  writeJson(path.join(missionDir('old'), 'state.json'), { state: 'done' });
  assert.deepStrictEqual(await waitAll(), []);

  askQuestion('demo', { key: 'a', text: 'First?', options: ['Yes', 'No'] });
  askQuestion('other', { key: 'b', text: 'Second?', options: ['Yes', 'No'] });
  writeJson(path.join(missionDir('old'), 'state.json'), { state: 'stopped' });
  const events = await waitAll();
  assert.deepStrictEqual(
    events.map((event) => `${event.mission} ${event.kind} ${event.id}`).sort(),
    ['demo question q-a', 'old mission old', 'other question q-b'],
  );

  answerQuestion('demo', 'q-a', '1');
  assert.deepStrictEqual(await waitAll(), []);
});

test('wait --all goes on with an unreadable snapshot or an unreadable mission', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  writeJson(path.join(missionDir('demo'), 'state.json'), { state: 'waiting' });
  askQuestion('demo', { key: 'k', text: 'Ok?', options: ['Yes', 'No'] });
  fs.mkdirSync(path.join(missionDir('broken')), { recursive: true });
  fs.writeFileSync(path.join(missionDir('broken'), 'mission.json'), '{ not json');
  fs.writeFileSync(path.join(require('../core/paths').home(), 'console-snapshot.json'), '{ not json');
  const events = await waitAll();
  assert.deepStrictEqual(events.map((event) => `${event.mission} ${event.id}`), ['demo q-k']);
});

test('a mission done is one event, whether or not its sessions are still stopping', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  writeJson(path.join(missionDir('demo'), 'state.json'), { state: 'working' });
  assert.deepStrictEqual(await waitAll(), []);
  writeJson(path.join(missionDir('demo'), 'state.json'), { state: 'done', stopping: true });
  assert.deepStrictEqual((await waitAll()).map((event) => `${event.kind} ${event.state}`), ['mission done, stopping']);
  writeJson(path.join(missionDir('demo'), 'state.json'), { state: 'done' });
  assert.deepStrictEqual(await waitAll(), []);
});

test('wait --all is refused to a session', async () => {
  const result = await relaylead(['wait', '--all', '--timeout', '0'], { RELAYLEAD_MISSION: 'demo' });
  assert.strictEqual(result.code, 1);
  assert.match(result.err, /belongs to the user/);
});

test('decision notes a line in decisions.md of the mission, and lists them', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  const env = { RELAYLEAD_MISSION: 'demo' };
  assert.strictEqual((await relaylead(['decision', 'Use', 'SQLite:', 'no', 'server'], env)).code, 0);
  assert.strictEqual((await relaylead(['decision', 'Skip the admin page'], env)).code, 0);
  const text = fs.readFileSync(path.join(missionDir('demo'), 'decisions.md'), 'utf8');
  assert.match(text, /^- \S+ Use SQLite: no server\n- \S+ Skip the admin page\n$/);
  assert.strictEqual((await relaylead(['decision', '--list'], env)).out, text);
  assert.strictEqual((await relaylead(['decision'], env)).code, 1);
  writeJson(path.join(missionDir('demo'), 'state.json'), { state: 'done' });
  const over = await relaylead(['decision', 'Too late'], env);
  assert.strictEqual(over.code, 1);
  assert.match(over.err, /is over/);
});

test('a message already read by a lead is read again by its successor with decision --list', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  const env = { RELAYLEAD_MISSION: 'demo' };
  await relaylead(['tell', 'demo', 'Do not use the v2 API']);
  const first = await relaylead(['wait', '--timeout', '0'], env);
  assert.strictEqual(JSON.parse(first.out).changes.find((change) => change.kind === 'message').text, 'Do not use the v2 API');
  // The first lead ends before noting anything; the next one finds nothing new in wait, but still reads it.
  assert.deepStrictEqual(JSON.parse((await relaylead(['wait', '--timeout', '0'], env)).out).changes, []);
  const listed = (await relaylead(['decision', '--list'], env)).out;
  assert.match(listed, /Messages from the user:\n- \S+ Do not use the v2 API\n$/);
});

test('the errors of tell and decision are also in French', () => {
  const { t } = require('../core/messages');
  for (const code of ['bad-tell', 'bad-decision', 'mission-over', 'mission-decision-over']) {
    assert.notStrictEqual(t(code, { mission: 'x' }, 'fr'), t(code, { mission: 'x' }, 'en'));
  }
});

test('wait --all returns at once in a one-shot session (claude -p), unless the timeout is short', async () => {
  const env = { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' };
  const started = Date.now();
  const long = await relaylead(['wait', '--all'], env);
  assert.strictEqual(long.code, 0);
  assert.match(long.out, /one-shot session: not waiting/);
  assert.ok(Date.now() - started < 2000);
  assert.match((await relaylead(['wait', '--all', '--timeout', '600'], env)).out, /not waiting/);
  assert.doesNotMatch((await relaylead(['wait', '--all', '--timeout', '0'], env)).out, /not waiting/);
  assert.doesNotMatch((await relaylead(['wait', '--all', '--timeout', '0'], { CLAUDE_CODE_ENTRYPOINT: 'cli' })).out, /not waiting/);
});
