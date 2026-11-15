// Process of a fake agent session. Usage: node agent.js <role>
// Like a real session, it acts only through the relaylead CLI, never by writing state files.
const { execFileSync } = require('node:child_process');
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

// Scripted lead: start the ready tasks (at most `parallel` at a time), wait, again, until all are finished.
function lead() {
  relaylead('state', 'set', 'working');
  const mission = readJson(path.join(missionDir(process.env.RELAYLEAD_MISSION), 'mission.json'));
  for (;;) {
    const tasks = JSON.parse(relaylead('task', 'list'));
    if (tasks.length === 0) return idle(); // nothing to do: wait to be stopped
    if (tasks.every((task) => ['done', 'failed', 'delivered'].includes(task.state))) {
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

// Scripted crew member: "works" 1 s on its task, reports it done, ends.
function crew() {
  setTimeout(() => {
    relaylead('task', 'done', process.env.RELAYLEAD_TASK, '--summary', 'fake work');
  }, 1000);
}

const role = process.argv[2];
if (role === 'lead') lead();
else if (role === 'crew' && process.env.RELAYLEAD_TASK) crew();
else idle();
