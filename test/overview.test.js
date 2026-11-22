const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { run } = require('../core/cli');
const { askQuestion } = require('../core/questions');
const { writePause } = require('../core/usage-pause');
const { writeJson, readJson } = require('../core/store');
const { home } = require('../core/paths');
const { makeIo } = require('../fixtures/helpers');
const { setupProject, writeMission } = require('../fixtures/missions');

async function overview() {
  const io = makeIo();
  assert.strictEqual(await run(['overview', '--json'], io), 0);
  return JSON.parse(io.out.text);
}

test('overview --json gathers missions, tasks, open questions, usage and display settings', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  askQuestion('demo', { key: 'db', text: 'Which database?', options: ['sqlite', 'postgres'], recommended: 2 });
  writeJson(path.join(home(), 'usage.json'), {
    claude: { at: new Date().toISOString(), fiveHour: { percent: 62, resetsAt: null }, sevenDay: { percent: 10, resetsAt: null } },
  });

  const view = await overview();
  assert.strictEqual(view.activeMissions, 1);
  assert.strictEqual(view.openQuestions, 1);
  const [mission] = view.missions;
  assert.deepStrictEqual(
    { name: mission.name, state: mission.state, active: mission.active, priority: mission.priority },
    { name: 'demo', state: 'starting', active: true, priority: 'normal' },
  );
  assert.deepStrictEqual(mission.tasks, [
    { id: 'a', title: 'First task', state: 'todo' },
    { id: 'b', title: 'Second task', state: 'todo' },
  ]);
  assert.deepStrictEqual(mission.questions[0].options, ['postgres', 'sqlite']);
  assert.strictEqual(mission.questions[0].recommended, 1);
  assert.strictEqual(view.usage.fiveHour.percent, 62);
  assert.deepStrictEqual(view.display, { pane: null, statusLine: true, dashboardPort: 4317 });
});

test('overview shows a pause, a finished mission, and drops a stale usage', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  writePause('demo', { reason: 'limit', resumeAt: Date.now() + 3600 * 1000 });
  writeJson(path.join(home(), 'usage.json'), { claude: { at: '2020-01-01T00:00:00.000Z', fiveHour: { percent: 99 }, sevenDay: null } });
  let view = await overview();
  assert.ok(view.missions[0].pausedUntil);
  assert.strictEqual(view.usage, null);

  askQuestion('demo', { key: 'x', text: 'Still open?', options: ['a', 'b'] });
  writeJson(path.join(home(), 'missions', 'demo', 'state.json'), { state: 'done', updatedAt: new Date().toISOString() });
  view = await overview();
  // Its open question stays visible and counted: a merge conflict is asked once the mission is done.
  assert.deepStrictEqual(
    { active: view.missions[0].active, questions: view.missions[0].questions.map((q) => q.id), pausedUntil: view.missions[0].pausedUntil },
    { active: false, questions: ['q-x'], pausedUntil: null },
  );
  assert.strictEqual(view.activeMissions, 0);
  assert.strictEqual(view.openQuestions, 1);
});

test('config set writes a display setting and refuses the others', async (t) => {
  setupProject(t, 'demo');
  const io = makeIo();
  assert.strictEqual(await run(['config', 'set', 'display.pane', 'never'], io), 0);
  assert.strictEqual(await run(['config', 'set', 'display.statusLine', 'false'], io), 0);
  assert.strictEqual(await run(['config', 'set', 'display.dashboardPort', '4400'], io), 0);
  const stored = readJson(path.join(home(), 'config.json'));
  assert.deepStrictEqual(stored.display, { pane: 'never', statusLine: false, dashboardPort: 4400 });
  assert.strictEqual(stored.delivery.type, 'files'); // the rest of the file is kept

  const bad = makeIo();
  assert.strictEqual(await run(['config', 'set', 'display.pane', 'maybe'], bad), 1);
  assert.strictEqual(await run(['config', 'set', 'delivery.type', 'x'], bad), 1);
});
