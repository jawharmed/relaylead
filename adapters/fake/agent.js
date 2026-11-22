// Process of a fake agent session. Usage: node agent.js <role>
// Like a real session, it acts only through the relaylead CLI, never by writing state files.
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { markEnded } = require('./watch-stop');
const { missionDir, slug } = require('../../core/paths');
const { readJson } = require('../../core/store');
const { DEFAULTS } = require('../../core/config');
const { recordHeartbeat, readReadings, recordFailure } = require('../../core/readings');
const { recordUsage } = require('../../core/usage');
const { readMail, markRead } = require('../../core/mailbox');
const { runFileSync } = require('../../core/run-file');

const CLI = path.join(__dirname, '..', '..', 'bin', 'relaylead.js');
const HOOKS = path.join(__dirname, '..', '..', 'core', 'hooks');
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

// The session's heartbeat, as its PostToolUse and Stop hooks would write it. Never fails the agent,
// and nothing without a mission (some adapter tests have none).
function heartbeat(tool, contextTokens) {
  const mission = process.env.RELAYLEAD_MISSION;
  const shortId = process.env.RELAYLEAD_FAKE_SHORT_ID;
  if (!mission || !shortId) return;
  try {
    recordHeartbeat(mission, shortId, { tool, contextTokens });
  } catch (err) {
    log(`heartbeat failed: ${err.message}`);
  }
}

// The context grows by RELAYLEAD_FAKE_TOKENS_PER_COMMAND (0 by default: flat) at each command, from
// the last heartbeat of this short id (a woken lead goes on counting), else from
// RELAYLEAD_FAKE_BASE_TOKENS (a new session).
function commandHeartbeat() {
  const mission = process.env.RELAYLEAD_MISSION;
  const last = mission ? readReadings(mission, process.env.RELAYLEAD_FAKE_SHORT_ID).heartbeat : null;
  const before = last && Number.isFinite(last.contextTokens) ? last.contextTokens : Number(process.env.RELAYLEAD_FAKE_BASE_TOKENS) || 40000;
  heartbeat('Bash', before + (Number(process.env.RELAYLEAD_FAKE_TOKENS_PER_COMMAND) || 0));
}

// The usage of the account, as the measuring status line would write it after each answer:
// RELAYLEAD_FAKE_USAGE_FIVE_HOUR and RELAYLEAD_FAKE_USAGE_SEVEN_DAY (percent), both windows resetting
// RELAYLEAD_FAKE_USAGE_RESETS_IN_S seconds from now (3600 by default). Nothing without them, and never
// fails the agent.
function fakeUsage() {
  const resetsAt = Math.floor(Date.now() / 1000) + (Number(process.env.RELAYLEAD_FAKE_USAGE_RESETS_IN_S) || 3600);
  const window = (name) => {
    const percent = process.env[name];
    return percent === undefined || percent === '' ? undefined : { used_percentage: Number(percent), resets_at: resetsAt };
  };
  try {
    recordUsage('claude', { five_hour: window('RELAYLEAD_FAKE_USAGE_FIVE_HOUR'), seven_day: window('RELAYLEAD_FAKE_USAGE_SEVEN_DAY') });
  } catch (err) {
    log(`usage failed: ${err.message}`);
  }
}

// A time as Claude Code writes it in the message of a usage limit: 2:54am.
function clockTime(date) {
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${date.getHours() % 12 || 12}:${minutes}${date.getHours() < 12 ? 'am' : 'pm'}`;
}

// RELAYLEAD_FAKE_RATE_LIMIT=1: the turn fails on the usage limit at once, as the StopFailure hook
// records it (no Stop hook, so no heartbeat), the limit resetting in an hour. Then the session stays
// alive and idle, like a Claude session.
function rateLimited() {
  const resetsAt = new Date(Date.now() + 60 * 60 * 1000);
  try {
    recordFailure(process.env.RELAYLEAD_MISSION, process.env.RELAYLEAD_FAKE_SHORT_ID, {
      error: 'rate_limit',
      last_assistant_message: `You've hit your 5-hour limit · resets ${clockTime(resetsAt)}`,
    });
  } catch (err) {
    log(`failure not recorded: ${err.message}`);
  }
  fs.writeFileSync(process.env.RELAYLEAD_FAKE_IDLE, '');
  log('turn failed: rate_limit');
  idle();
}

// The session's mail, as its PostToolUse hook would pass it on: each message goes to the log, then
// into read/. Returns the texts read. Never fails the agent.
function takeMail() {
  const mission = process.env.RELAYLEAD_MISSION;
  const shortId = process.env.RELAYLEAD_FAKE_SHORT_ID;
  if (!mission || !shortId) return [];
  try {
    const mail = readMail(mission, shortId);
    for (const message of mail) log(`mail: ${message.text}`);
    markRead(mission, shortId, mail.map((message) => message.file));
    return mail.map((message) => message.text);
  } catch (err) {
    log(`mail failed: ${err.message}`);
    return [];
  }
}

// The env carries RELAYLEAD_MISSION and RELAYLEAD_HOME; no shell and no PATH lookup. A failed command
// is still an action of the session: its heartbeat is written and its mail taken too.
// A message that asks the session to give up: a lead to hand over, a crew member whose context is
// full to fail its task. Seen in the mail taken after a command, it ends the lead's loop (HANDOVER).
let toldTo = null;
const HANDOVER = new Error('told to hand over');

function readOrders(texts) {
  for (const text of texts) {
    if (text.includes('relaylead state set handover')) toldTo = toldTo || 'handover';
    if (text.includes('relaylead task fail')) toldTo = toldTo || 'fail';
  }
}

function relaylead(...args) {
  let result;
  try {
    result = logged(`relaylead ${args.join(' ')}`, () =>
      runFileSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }),
    );
  } finally {
    commandHeartbeat();
    fakeUsage();
    readOrders(takeMail());
  }
  if (toldTo === 'handover' && process.argv[2] === 'lead') throw HANDOVER;
  return result;
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

// Like the lead's instruction before it declares the mission done: writes the project memory (one line).
function compactMemory() {
  const shown = relaylead('memory', 'show');
  if (/turned off/.test(shown)) return;
  const fingerprint = /--base\): (\w+)/.exec(shown)[1];
  relaylead('memory', 'write', '--base', fingerprint, '--text', '- fake mission: done');
}

// Stay alive until stopped, like a real session.
function idle() {
  setInterval(() => {}, 60 * 1000);
}

// End the turn but stay alive, like a Claude session that is done and idle: the adapter's list reads
// the file RELAYLEAD_FAKE_IDLE, never the pid. The heartbeat of its Stop hook comes first.
function endTurn() {
  heartbeat('(stop)', null);
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

// Ends the turn when nothing has changed since the last wait, after saying the mission waits: true
// when the turn is over, false when there are changes to look at.
function waitOrEndTurn(note) {
  relaylead('state', 'set', 'waiting', '--note', note);
  const { changes } = JSON.parse(relaylead('wait', '--timeout', '0'));
  if (changes.length > 0) return false;
  endTurn();
  return true;
}

// Scripted lead: deliver the done tasks, retry the failed ones and start the ready ones (at most
// `parallel` running at a time), wait, again, until every task is delivered or failed for good. While
// no task runs, it ends its turn (Relaylead wakes it); with RELAYLEAD_FAKE_LEAD_ENDS_TURN=1, also
// while tasks run. Refused as a replaced lead (not-current-lead), it ends its turn.
function lead() {
  try {
    leadLoop();
  } catch (err) {
    if (err === HANDOVER) {
      toldTo = 'handed-over';
      relaylead('state', 'set', 'handover', '--note', 'fake handover');
      endTurn();
      return;
    }
    // The text of not-current-lead (core/messages.js), in English or in French.
    if (!/is no longer the lead of mission|n'est plus le lead de la mission/.test(String(err.stderr || ''))) throw err;
    log('not the current lead: ending the turn');
    endTurn();
  }
}

function leadLoop() {
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
      compactMemory();
      relaylead('state', 'set', 'done');
      return;
    }
    // A queued task waits for a place on the machine: it counts as running.
    let running = tasks.filter((task) => ['running', 'queued'].includes(task.state)).length;
    // A task refused by the guard waits for the user's answer to its question: the user retries it.
    for (const task of tasks.filter((candidate) => retryable(candidate) && !/\(question q-(perm|irr)-/.test(candidate.summary || ''))) {
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
    if (!deliveryFailed && running === 0) {
      if (waitOrEndTurn('fake: waiting for answers')) return;
      continue;
    }
    if (!deliveryFailed && process.env.RELAYLEAD_FAKE_LEAD_ENDS_TURN === '1') {
      if (waitOrEndTurn('fake: waiting for crew')) return;
      continue;
    }
    // A short timeout: if this lead is killed, its orphaned wait ends soon too. Shorter still when
    // a delivery is to be tried again.
    relaylead('wait', '--timeout', deliveryFailed ? '1' : '5');
  }
}

// Tries a Bash command the way Claude Code would: the PreToolUse hook first, then the permission
// hook, each run as `node <hook>` with the tool call as JSON on stdin. The command itself is never
// run. Returns the refusal message of the first hook that denies it, or null.
function tryCommand(command) {
  const input = JSON.stringify({
    session_id: `fake-${process.env.RELAYLEAD_FAKE_SHORT_ID}`,
    tool_name: 'Bash',
    tool_input: { command },
    cwd: process.cwd(),
  });
  const run = (hook) => {
    const out = logged(`hook ${hook} ${command}`, () =>
      runFileSync(process.execPath, [path.join(HOOKS, `${hook}.js`)], { input, encoding: 'utf8', windowsHide: true }),
    );
    return out.trim() ? JSON.parse(out).hookSpecificOutput : {};
  };
  const pretool = run('pretool');
  if (pretool.permissionDecision === 'deny') return pretool.permissionDecisionReason;
  const permission = run('permission');
  return permission.decision.behavior === 'deny' ? permission.decision.message : null;
}

// Scripted crew member: "works" 1 s on its task, writes <id>.txt in its working folder (committed on
// its branch, unless the delivery is files), reports it done, ends. A task named in RELAYLEAD_FAKE_FAIL_FIRST
// (ids separated by commas) is reported failed on its first attempt instead. RELAYLEAD_FAKE_TRY, a
// JSON object {task id: command}, makes the task try that command first (tryCommand): refused, the
// task is reported failed with the refusal as its summary.
function crew() {
  const id = process.env.RELAYLEAD_TASK;
  const gate = process.env.RELAYLEAD_FAKE_CREW_GATE;
  if (!gate) return work(id);
  // Behind the gate (a folder): waits for <gate>/<id>, reading its mail every 50 ms.
  const timer = setInterval(() => {
    readOrders(takeMail());
    if (toldTo === 'fail') {
      clearInterval(timer);
      return failContextFull(id);
    }
    if (!fs.existsSync(path.join(gate, id))) return;
    clearInterval(timer);
    work(id);
  }, 50);
}

// Told its context is full: fails its task, and ends.
function failContextFull(id) {
  relaylead('task', 'fail', id, '--summary', 'context full: fake');
  process.exit(0);
}

function work(id) {
  const failFirst = (process.env.RELAYLEAD_FAKE_FAIL_FIRST || '').split(',').includes(id);
  const command = JSON.parse(process.env.RELAYLEAD_FAKE_TRY || '{}')[id];
  setTimeout(() => {
    if (failFirst && process.env.RELAYLEAD_ATTEMPT === '1') {
      relaylead('task', 'fail', id, '--summary', 'fake failure');
      return;
    }
    const refusal = command ? tryCommand(command) : null;
    if (refusal) {
      relaylead('task', 'fail', id, '--summary', refusal);
      return;
    }
    fs.writeFileSync(`${id}.txt`, `fake work on ${id}\n`);
    if (readMission().config.delivery.type !== 'files') {
      git('add', `${id}.txt`);
      git('commit', '-m', id);
    }
    if (toldTo === 'fail') return failContextFull(id);
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
else if (process.env.RELAYLEAD_FAKE_RATE_LIMIT === '1') rateLimited();
else if (role === 'lead') lead();
else if (role === 'crew' && process.env.RELAYLEAD_TASK) crew();
else idle();
