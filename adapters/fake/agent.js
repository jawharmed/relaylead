// Process of a fake agent session. Usage: node agent.js <role>
// Like a real session, it acts only through the relaylead CLI, never by writing state files.
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { markEnded } = require('./watch-stop');
const { missionDir, slug } = require('../../core/paths');
const { readJson } = require('../../core/store');
const { DEFAULTS } = require('../../core/config');
const { runFileSync } = require('../../core/run-file');

const CLI = path.join(__dirname, '..', '..', 'bin', 'relaylead.js');
// A delivery may fail for a moment (a git lock, a folder still busy on Windows): it is tried again
// at the next turn of the loop, and the lead stops after this many failures.
const DELIVERY_ATTEMPTS = 3;

// Appends to the log file given by the adapter, in the mission folder. Every command is logged when
// it starts and when it ends, so a command that never ends shows in a test's timeout report.
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
  return logged(`relaylead ${args.join(' ')}`, () =>
    runFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }),
  );
}

// Like a real crew member's git (gc and maintenance left as they are), but the agent does not wait
// for a process git leaves behind with its output open.
function git(...args) {
  logged(`git ${args.join(' ')}`, () => runFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
}

function logged(command, action) {
  log(`start ${command}`);
  try {
    const result = action();
    log(`end ${command}`);
    return result;
  } catch (err) {
    log(`${command} failed (exit ${err.status}): ${String(err.stderr || err.message).trim()}`);
    throw err;
  }
}

// Stay alive until stopped, like a real session.
function idle() {
  setInterval(() => {}, 60 * 1000);
}

// End the turn but stay alive, like a Claude session that is done and idle: the adapter's list reads
// the file RELAYLEAD_FAKE_IDLE, never the pid.
function endTurn() {
  fs.writeFileSync(process.env.RELAYLEAD_FAKE_IDLE, '');
  log('turn ended');
  idle();
}

function readMission() {
  return readJson(path.join(missionDir(process.env.RELAYLEAD_MISSION), 'mission.json'));
}

// The answers by question id, read like a real lead would: through the CLI.
function questionsById() {
  const questions = JSON.parse(relaylead('question', 'list', '--all'));
  return Object.fromEntries(questions.map((question) => [question.id, question]));
}

// A task with `ask` waits for an answer before it starts: asks once (the key is the task id),
// then reports whether the answer is there.
function answeredIfAsked(task) {
  if (!task.ask) return true;
  relaylead('question', 'ask', '--key', task.id, '--text', task.ask, '--option', 'yes', '--option', 'no', '--recommended', '1');
  const question = questionsById()[`q-${slug(task.id)}`];
  return question.state === 'answered';
}

function listTasks() {
  return JSON.parse(relaylead('task', 'list'));
}

// Scripted lead: deliver the done tasks, retry the failed ones and start the ready ones (at most
// `parallel` running at a time), wait, again, until every task is delivered or failed for good.
function lead() {
  relaylead('state', 'set', 'working');
  const mission = readMission();
  const maxAttempts = mission.config.maxAttempts || DEFAULTS.maxAttempts;
  const retryable = (task) => task.state === 'failed' && task.attempt < maxAttempts;
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
    if (tasks.every((task) => task.state === 'delivered' || (task.state === 'failed' && !retryable(task)))) {
      relaylead('state', 'set', 'done');
      return;
    }
    let running = tasks.filter((task) => task.state === 'running').length;
    for (const task of tasks.filter(retryable)) {
      if (running >= mission.config.parallel) break;
      relaylead('task', 'retry', task.id);
      running++;
    }
    for (const task of tasks.filter((candidate) => candidate.ready)) {
      if (running >= mission.config.parallel) break;
      if (!answeredIfAsked(task)) continue;
      relaylead('task', 'start', task.id);
      running++;
    }
    // A short timeout: if this lead is killed, its orphaned wait ends soon too. Shorter still when
    // a delivery is to be tried again.
    relaylead('wait', '--timeout', deliveryFailed ? '1' : '5');
  }
}

// Scripted crew member: "works" 1 s on its task, writes <id>.txt in its working folder (committed on
// its branch with local-merge), reports it done, ends. A task named in RELAYLEAD_FAKE_FAIL_FIRST
// (ids separated by commas) is reported failed on its first attempt instead.
function crew() {
  const id = process.env.RELAYLEAD_TASK;
  const failFirst = (process.env.RELAYLEAD_FAKE_FAIL_FIRST || '').split(',').includes(id);
  setTimeout(() => {
    if (failFirst && process.env.RELAYLEAD_ATTEMPT === '1') {
      relaylead('task', 'fail', id, '--summary', 'fake failure');
      return;
    }
    fs.writeFileSync(`${id}.txt`, `fake work on ${id}\n`);
    if (readMission().config.delivery.type === 'local-merge') {
      git('add', `${id}.txt`);
      git('commit', '-m', id);
    }
    relaylead('task', 'done', id, '--summary', 'fake work');
  }, 1000);
}

// The adapter's stop writes RELAYLEAD_FAKE_STOP: a thread of its own (watch-stop.js) then ends the
// process. However the agent ends, it writes RELAYLEAD_FAKE_ENDED, which the adapter's list reads.
function watchStop() {
  const files = { stopFile: process.env.RELAYLEAD_FAKE_STOP, endedFile: process.env.RELAYLEAD_FAKE_ENDED };
  if (!files.stopFile || !files.endedFile) return;
  process.on('exit', () => markEnded(files));
  // unref: a crew member still ends by itself once its work is done.
  new Worker(path.join(__dirname, 'watch-stop.js'), { workerData: files }).unref();
}

// Any failure ends the agent, with its reason (and git's or relaylead's stderr) in the log.
process.on('uncaughtException', (err) => {
  log(`crashed: ${err.stack}${err.stderr ? '\n' + err.stderr : ''}`);
  process.exit(1);
});

watchStop();
// Woken by the adapter's wake: the message it was given, as the first thing in the log.
if (process.env.RELAYLEAD_FAKE_WAKE_MESSAGE) log(`woken: ${process.env.RELAYLEAD_FAKE_WAKE_MESSAGE}`);
const role = process.argv[2];
// For the tests: a session that ends its first turn at once, keeping its role in the registry.
if (process.env.RELAYLEAD_FAKE_END_FIRST_TURN === '1') endTurn();
else if (role === 'lead') lead();
else if (role === 'crew' && process.env.RELAYLEAD_TASK) crew();
else idle();
