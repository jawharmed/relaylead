// Process of a fake agent session. Usage: node agent.js <role>
// Like a real session, it acts only through the relaylead CLI, never by writing state files.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { missionDir } = require('../../core/paths');
const { readJson } = require('../../core/store');

const CLI = path.join(__dirname, '..', '..', 'bin', 'relaylead.js');
// A delivery may fail for a moment (a git lock, a folder still busy on Windows): it is tried again
// at the next turn of the loop, and the lead stops after this many failures.
const DELIVERY_ATTEMPTS = 3;

// Appends to the log file given by the adapter, in the mission folder.
function log(text) {
  if (!process.env.RELAYLEAD_FAKE_LOG) return;
  try {
    fs.appendFileSync(process.env.RELAYLEAD_FAKE_LOG, `${new Date().toISOString()} ${text}\n`);
  } catch {
    // The mission folder is gone: nobody will read the log.
  }
}

// The env carries RELAYLEAD_MISSION and RELAYLEAD_HOME; no shell and no PATH lookup.
function relaylead(...args) {
  try {
    return execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    log(`relaylead ${args.join(' ')} failed (exit ${err.status}): ${String(err.stderr || err.message).trim()}`);
    throw err;
  }
}

function git(...args) {
  execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
  const failedDeliveries = {};
  for (;;) {
    let tasks = listTasks();
    if (tasks.length === 0) return idle(); // nothing to do: wait to be stopped
    const done = tasks.filter((task) => task.state === 'done');
    let deliveryFailed = false;
    for (const task of done) {
      try {
        relaylead('task', 'deliver', task.id);
      } catch {
        failedDeliveries[task.id] = (failedDeliveries[task.id] || 0) + 1;
        if (failedDeliveries[task.id] >= DELIVERY_ATTEMPTS) {
          log(`stopping: task ${task.id} could not be delivered`);
          process.exit(1);
        }
        deliveryFailed = true;
      }
    }
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
    // A short timeout: if this lead is killed, its orphaned wait ends soon too. Shorter still when
    // a delivery is to be tried again.
    relaylead('wait', '--timeout', deliveryFailed ? '1' : '5');
  }
}

// Scripted crew member: "works" 1 s on its task, writes <id>.txt in its working folder (committed on
// its branch with local-merge), reports it done, ends.
function crew() {
  const id = process.env.RELAYLEAD_TASK;
  setTimeout(() => {
    fs.writeFileSync(`${id}.txt`, `fake work on ${id}\n`);
    if (readMission().config.delivery.type === 'local-merge') {
      git('add', `${id}.txt`);
      git('commit', '-m', id);
    }
    relaylead('task', 'done', id, '--summary', 'fake work');
  }, 1000);
}

// Any failure ends the agent, with its reason (and git's or relaylead's stderr) in the log.
process.on('uncaughtException', (err) => {
  log(`crashed: ${err.stack}${err.stderr ? '\n' + err.stderr : ''}`);
  process.exit(1);
});

const role = process.argv[2];
if (role === 'lead') lead();
else if (role === 'crew' && process.env.RELAYLEAD_TASK) crew();
else idle();
