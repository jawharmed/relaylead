// Process of a fake agent session. Usage: node agent.js <role>
// Like a real session, it acts only through the relaylead CLI, never by writing state files.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { missionDir } = require('../../core/paths');
const { readJson } = require('../../core/store');

const CLI = path.join(__dirname, '..', '..', 'bin', 'relaylead.js');

// The env carries RELAYLEAD_MISSION and RELAYLEAD_HOME; no shell and no PATH lookup.
function relaylead(...args) {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true });
}

// Stay alive until stopped, like a real session.
function idle() {
  setInterval(() => {}, 60 * 1000);
}

function readMission() {
  return readJson(path.join(missionDir(process.env.RELAYLEAD_MISSION), 'mission.json'));
}

function listTasks() {
  return JSON.parse(relaylead('task', 'list'));
}

// Scripted lead: deliver the done tasks, start the ready ones (at most `parallel` at a time), wait,
// again, until every task is delivered or failed.
function lead() {
  relaylead('state', 'set', 'working');
  const mission = readMission();
  for (;;) {
    let tasks = listTasks();
    if (tasks.length === 0) return idle(); // nothing to do: wait to be stopped
    const done = tasks.filter((task) => task.state === 'done');
    for (const task of done) relaylead('task', 'deliver', task.id);
    if (done.length > 0) tasks = listTasks(); // delivered tasks make their dependents ready
    if (tasks.every((task) => ['delivered', 'failed'].includes(task.state))) {
      relaylead('state', 'set', 'done');
      return;
    }
    let running = tasks.filter((task) => task.state === 'running').length;
    for (const task of tasks.filter((candidate) => candidate.ready)) {
      if (running >= mission.config.parallel) break;
      relaylead('task', 'start', task.id);
      running++;
    }
    // A short timeout: if this lead is killed, its orphaned wait ends soon too.
    relaylead('wait', '--timeout', '5');
  }
}

// Scripted crew member: "works" 1 s on its task, writes <id>.txt in its working folder (committed on
// its branch with local-merge), reports it done, ends.
function crew() {
  const id = process.env.RELAYLEAD_TASK;
  setTimeout(() => {
    fs.writeFileSync(`${id}.txt`, `fake work on ${id}\n`);
    if (readMission().config.delivery.type === 'local-merge') {
      execFileSync('git', ['add', `${id}.txt`], { stdio: 'ignore', windowsHide: true });
      execFileSync('git', ['commit', '-m', id], { stdio: 'ignore', windowsHide: true });
    }
    relaylead('task', 'done', id, '--summary', 'fake work');
  }, 1000);
}

const role = process.argv[2];
if (role === 'lead') lead();
else if (role === 'crew' && process.env.RELAYLEAD_TASK) crew();
else idle();
