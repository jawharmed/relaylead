// The end of a mission: its sessions leave the agent's list; a mission left waiting is reported.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startTask } = require('../core/tasks');
const { stopMission, reapLead } = require('../core/missions');
const { readJson, writeJson } = require('../core/store');
const { askQuestion } = require('../core/questions');
const { listSessions } = require('../core/sessions');
const { missionDir } = require('../core/paths');
const { tmpDir } = require('../fixtures/helpers');
const { setupProject, writeMission } = require('../fixtures/missions');
const { installEnv, runRelaylead } = require('../fixtures/install-env');

// The short ids the fake agent was asked to forget (adapters/fake, fake-forget.log).
function forgotten(name) {
  const file = path.join(missionDir(name), 'fake-forget.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => line.split(' ').pop()) : [];
}

test('a stopped mission takes its sessions out of the agent\'s list', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  await startTask('demo', { id: 'a' });
  const [crew] = listSessions('demo');

  await stopMission('demo');

  assert.deepStrictEqual(forgotten('demo'), [crew.shortId]);
});

// Every file of the folder dated `days` days ago.
function age(folder, days) {
  const then = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) age(file, days);
    else fs.utimesSync(file, then, then);
  }
}

test('a mission waiting for an answer with nothing moving for abandonDays is shown abandoned by list and doctor, and kept', async (t) => {
  const env = installEnv(t);
  process.env.RELAYLEAD_HOME = env.RELAYLEAD_HOME;
  for (const name of ['quiet', 'recent']) {
    writeMission(name, fs.realpathSync.native(tmpDir('relaylead-project-')));
    askQuestion(name, { key: 'db', text: 'Which database?', options: ['postgres', 'sqlite'] });
  }
  age(missionDir('quiet'), 8);
  age(missionDir('recent'), 3);

  const list = await runRelaylead(['list'], { cwd: tmpDir(), env });
  assert.match(list.out, /^quiet {2}starting \(abandoned\) {2}/m);
  assert.match(list.out, /^recent {2}starting {2}/m);
  const doctor = await runRelaylead(['doctor'], { cwd: tmpDir(), env });
  assert.match(doctor.out, /^warn mission quiet: abandoned: a question is open and nothing has moved for 7 days;/m);
  assert.doesNotMatch(doctor.out, /mission recent/);
  assert.ok(fs.existsSync(path.join(missionDir('quiet'), 'mission.json')));
});

test('the helper that stops the lead of a done mission forgets only the sessions that have ended', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  const gate = tmpDir('relaylead-gate-');
  const before = process.env.RELAYLEAD_FAKE_CREW_GATE;
  process.env.RELAYLEAD_FAKE_CREW_GATE = gate; // the crew member keeps working
  t.after(() => {
    if (before === undefined) delete process.env.RELAYLEAD_FAKE_CREW_GATE;
    else process.env.RELAYLEAD_FAKE_CREW_GATE = before;
  });
  await startTask('demo', { id: 'a' });
  const [crew] = listSessions('demo');
  // A lead already gone: the helper has nothing to stop.
  writeJson(path.join(missionDir('demo'), 'lead.json'), { shortId: 'dead0001', sessionName: 'demo/lead/1' });

  await reapLead('demo', readJson(path.join(missionDir('demo'), 'mission.json')).createdAt);

  assert.ok(!forgotten('demo').includes(crew.shortId), 'a live crew member stays in the agent\'s list');
});
