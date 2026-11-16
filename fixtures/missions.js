// A project folder with two tasks (b depends on a), shared by the task and wait tests.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { missionDir } = require('../core/paths');
const { writeJson } = require('../core/store');
const { loadConfig } = require('../core/config');
const { listSessions, isAlive } = require('../core/sessions');
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

// The pid in start.lock (a JSON holder, or a pid alone), or 0.
function lockHolder(name) {
  try {
    const holder = JSON.parse(fs.readFileSync(path.join(missionDir(name), 'start.lock'), 'utf8'));
    return Number(typeof holder === 'object' && holder ? holder.pid : holder) || 0;
  } catch {
    return 0;
  }
}

// The live processes of a mission: its sessions, the holder of start.lock, and their descendants,
// with how long they have run. A command stuck in a test shows here. Not on Windows (no ps).
function missionProcesses(name) {
  if (process.platform === 'win32') return [];
  const roots = [...listSessions(name).map((session) => session.pid), lockHolder(name)].filter(isAlive);
  let rows;
  try {
    rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,etime=,command='], { encoding: 'utf8', timeout: 10000 })
      .split('\n')
      .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
      .filter(Boolean)
      .map(([line, pid, ppid]) => ({ line, pid: Number(pid), ppid: Number(ppid) }));
  } catch (err) {
    return [`ps failed: ${err.message}`];
  }
  const shown = new Set(roots);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows) {
      if (!shown.has(row.pid) && shown.has(row.ppid)) {
        shown.add(row.pid);
        grew = true;
      }
    }
  }
  return rows.filter((row) => shown.has(row.pid)).map((row) => row.line);
}

// Every file of a mission folder (state, tasks, results, sessions, fake agent logs) and its live
// processes, for a test failure message.
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
  lines.push('--- processes (pid ppid elapsed command)', ...missionProcesses(name));
  return lines.join('\n');
}

module.exports = { freshHome, setupProject, writeMission, missionReport };
