// `relaylead brief`, the opening of the console, and the short outputs it reads (wait --all, task list --short).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../core/cli');
const doctorCheck = require('../core/doctor');
const { missionDir } = require('../core/paths');
const { writeJson } = require('../core/store');
const { askQuestion } = require('../core/questions');
const { writePause, localTime } = require('../core/usage-pause');
const { makeIo } = require('../fixtures/helpers');
const { setupProject, writeMission } = require('../fixtures/missions');

async function relaylead(args, { env = {}, cwd } = {}) {
  const io = makeIo({ env });
  if (cwd) io.cwd = cwd;
  const code = await run(args, io);
  assert.strictEqual(code, 0, io.err.text);
  return io.out.text;
}

// doctor without claude, launchctl or the plugin list: the lines a test gives.
function doctorSays(t, lines) {
  const real = doctorCheck.doctor;
  doctorCheck.doctor = async () => lines;
  t.after(() => {
    doctorCheck.doctor = real;
  });
}

function setState(name, state) {
  writeJson(path.join(missionDir(name), 'state.json'), { state, updatedAt: new Date().toISOString() });
}

test('brief with nothing to say: no installation part, three short lines', async (t) => {
  setupProject(t, 'demo');
  doctorSays(t, [{ level: 'ok', name: 'node', detail: '22' }]);
  assert.strictEqual(await relaylead(['brief']), 'Nothing new.\nNo open question.\nNo mission running.\n');
});

test('brief shows the problems, each open question as it is, and one line per mission not over', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  setState('demo', 'working');
  writeJson(path.join(missionDir('demo'), 'mission.json'), { ...JSON.parse(fs.readFileSync(path.join(missionDir('demo'), 'mission.json'), 'utf8')), priority: 'high' });
  writeJson(path.join(missionDir('demo'), 'tasks', 'a.result.json'), { state: 'done', summary: 'ok' });
  // A finished mission: its question (a merge conflict) is shown, the mission has no line.
  writeMission('old', dir);
  askQuestion('old', { key: 'merge', text: 'Conflict in src/a.js. What now?', context: 'Two edits of the same line.\nSee the branch.', options: ['Resolve it here', 'Pause'], recommended: 1 });
  setState('old', 'done');
  doctorSays(t, [
    { level: 'ok', name: 'node', detail: '22' },
    { level: 'warn', name: 'scheduler', detail: 'not installed; run: relaylead install' },
  ]);

  const text = await relaylead(['brief']);
  assert.strictEqual(
    text,
    [
      'Installation problems:',
      '  warn scheduler: not installed; run: relaylead install',
      'Nothing new.',
      'Open questions (1):',
      '[old] q-merge (new): Conflict in src/a.js. What now?',
      '  Two edits of the same line.',
      '  See the branch.',
      '  1. Resolve it here (recommended)',
      '  2. Pause',
      'Missions not over:',
      '  demo: working · tasks 0/2 delivered (1 done) · priority high',
      '',
    ].join('\n'),
  );
  // Same catch-up as wait --all: the question is no longer new, and the next wait does not give it again.
  assert.match(await relaylead(['brief']), /\[old\] q-merge: Conflict/);
  assert.strictEqual(await relaylead(['wait', '--all', '--timeout', '0']), 'Nothing new.\n');
});

test('brief says a queued task once, as waiting for a place, and a pause with its end', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  setState('demo', 'working');
  writeJson(path.join(missionDir('demo'), 'tasks', 'a.json'), { id: 'a', profile: 'developer', attempt: 1, state: 'queued', session: null, queuedAt: new Date().toISOString() });
  const resumeAt = Date.now() + 3600 * 1000;
  writePause('demo', { reason: 'limit', resumeAt });
  doctorSays(t, []);
  const line = (await relaylead(['brief'])).split('\n').find((text) => text.startsWith('  demo:'));
  assert.strictEqual(line, `  demo: working · tasks 0/2 delivered · 1 waiting for a place · paused until ${localTime(new Date(resumeAt).toISOString())}`);
});

test('brief gives a mission over and a failed task once, in French when the project says so', async (t) => {
  const dir = setupProject(t, 'demo');
  fs.writeFileSync(path.join(dir, '.relaylead.json'), JSON.stringify({ language: 'fr' }));
  writeMission('demo', dir);
  setState('demo', 'working');
  doctorSays(t, []);
  await relaylead(['brief'], { cwd: dir });

  writeJson(path.join(missionDir('demo'), 'tasks', 'a.json'), { id: 'a', profile: 'developer', attempt: 1, state: 'failed', session: null, summary: 'tests rouges' });
  setState('demo', 'stopped');
  const text = await relaylead(['brief'], { cwd: dir });
  assert.strictEqual(
    text,
    'Nouveau :\n  [demo] mission stopped\n  [demo] tâche a en échec (essai 1) : tests rouges\nAucune question ouverte.\nAucune mission en cours.\n',
  );
  assert.match(await relaylead(['brief'], { cwd: dir }), /^Rien de nouveau\.\n/);
});

test('wait --all prints its events as text, a question in full; --json keeps the JSON', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  setState('demo', 'waiting');
  askQuestion('demo', { key: 'db', text: 'Which database?', options: ['SQLite', 'Postgres'], recommended: 2 });
  assert.strictEqual(
    await relaylead(['wait', '--all', '--timeout', '0']),
    '[demo] q-db (new): Which database?\n  1. Postgres (recommended)\n  2. SQLite\n',
  );
  askQuestion('demo', { key: 'api', text: 'Which API?', options: ['v1', 'v2'] });
  const { events } = JSON.parse(await relaylead(['wait', '--all', '--timeout', '0', '--json']));
  assert.deepStrictEqual(events.map((event) => event.id), ['q-api']);
});

test('task list --short prints one line per task', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  writeJson(path.join(missionDir('demo'), 'tasks', 'a.json'), { id: 'a', profile: 'developer', attempt: 2, state: 'failed', session: null, summary: 'no tests' });
  assert.strictEqual(
    await relaylead(['task', 'list', '--short', '--mission', 'demo']),
    'a  failed#2  First task — no tests\nb  todo#0  Second task\n',
  );
});
