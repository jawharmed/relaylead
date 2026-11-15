// A project folder with two tasks (b depends on a), shared by the task and wait tests.
const fs = require('node:fs');
const path = require('node:path');
const { missionDir } = require('../core/paths');
const { writeJson } = require('../core/store');
const { loadConfig } = require('../core/config');
const { listSessions } = require('../core/sessions');
const fake = require('../adapters/fake');
const { tmpDir } = require('./helpers');

const TASK_A = '---\ntitle: First task\n---\n\nWrite the first file.\n';
const TASK_B = '---\ntitle: Second task\ndepends: [a]\n---\n\nWrite the second file.\n';

// Fresh RELAYLEAD_HOME and project folder; every session of `mission` is stopped after the test.
function setupProject(t, mission) {
  const home = tmpDir('relaylead-home-');
  process.env.RELAYLEAD_HOME = home;
  const dir = fs.realpathSync.native(tmpDir('relaylead-project-'));
  fs.mkdirSync(path.join(dir, 'tasks'));
  fs.writeFileSync(path.join(dir, 'tasks', 'a.md'), TASK_A);
  fs.writeFileSync(path.join(dir, 'tasks', 'b.md'), TASK_B);
  t.after(async () => {
    process.env.RELAYLEAD_HOME = home;
    for (const session of listSessions(mission)) await fake.stop(session);
  });
  return dir;
}

// mission.json as createMission writes it, but no lead is started: the test plays the lead.
function writeMission(name, dir) {
  writeJson(path.join(missionDir(name), 'mission.json'), {
    name,
    dir,
    agent: 'fake',
    createdAt: new Date().toISOString(),
    config: loadConfig({ dir }),
  });
}

module.exports = { setupProject, writeMission };
