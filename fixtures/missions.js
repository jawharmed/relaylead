// A project folder with two tasks (b depends on a), shared by the task and wait tests.
const fs = require('node:fs');
const path = require('node:path');
const { missionDir } = require('../core/paths');
const { writeJson } = require('../core/store');
const { loadConfig } = require('../core/config');
const { listSessions } = require('../core/sessions');
const { listMissions } = require('../core/missions');
const fake = require('../adapters/fake');
const { tmpDir } = require('./helpers');

// Taken now, so the cleanup still kills sessions when a test has replaced fake.stop.
const stopSession = fake.stop;

const TASK_A = '---\ntitle: First task\n---\n\nWrite the first file.\n';
const TASK_B = '---\ntitle: Second task\ndepends: [a]\n---\n\nWrite the second file.\n';

// Fresh RELAYLEAD_HOME and project folder; every session of `mission` is stopped after the test.
// The folder is not a git repository: its crew members deliver files (machine config).
function setupProject(t, mission) {
  const home = tmpDir('relaylead-home-');
  process.env.RELAYLEAD_HOME = home;
  writeJson(path.join(home, 'config.json'), { delivery: { type: 'files' } });
  const dir = fs.realpathSync.native(tmpDir('relaylead-project-'));
  fs.mkdirSync(path.join(dir, 'tasks'));
  fs.writeFileSync(path.join(dir, 'tasks', 'a.md'), TASK_A);
  fs.writeFileSync(path.join(dir, 'tasks', 'b.md'), TASK_B);
  t.after(async () => {
    process.env.RELAYLEAD_HOME = home;
    for (const session of listSessions(mission)) await stopSession(session);
  });
  return dir;
}

// Fresh RELAYLEAD_HOME for a test that launches missions; every session they started is killed
// afterwards. The project folders are not git repositories: missions deliver files (machine config).
function freshHome(t) {
  const home = tmpDir('relaylead-home-');
  process.env.RELAYLEAD_HOME = home;
  writeJson(path.join(home, 'config.json'), { delivery: { type: 'files' } });
  // Kill every recorded session directly: stopMission leaves a finished mission alone.
  t.after(async () => {
    process.env.RELAYLEAD_HOME = home;
    for (const mission of listMissions()) {
      for (const session of listSessions(mission.name)) await stopSession(session);
    }
  });
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

// Every file of a mission folder (state, tasks, results, sessions, fake agent logs), for a test
// failure message.
function missionReport(name) {
  const lines = [`--- mission ${name}`];
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else lines.push(`--- ${path.relative(missionDir(name), file)}`, fs.readFileSync(file, 'utf8'));
    }
  };
  try {
    walk(missionDir(name));
  } catch (err) {
    lines.push(String(err));
  }
  return lines.join('\n');
}

module.exports = { freshHome, setupProject, writeMission, missionReport };
