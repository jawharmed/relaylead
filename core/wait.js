// `relaylead wait`: blocks the lead until a task or a question of its mission changes, then says what changed.
// The end of a crew session is not reported: it reads as a change of its task (done, or failed by wait).
// The last view is kept in wait-snapshot.json, so a change made while nobody waits is reported by the next wait.
const path = require('node:path');
const { missionDir } = require('./paths');
const { writeJson, readJson } = require('./store');
const { readMission, getState, currentLeadError } = require('./missions');
const { sleep } = require('./timing');
const { codedError } = require('./messages');
const { listTasks, markFailed } = require('./tasks');
const { listQuestions } = require('./questions');
const { getAdapter } = require('../adapters');

const DEFAULT_TIMEOUT_S = 100;
const MAX_TIMEOUT_S = 540;
// Task and question files are read this often; the adapter is asked less often: with Claude, each
// list runs `claude agents --json --all`.
const POLL_MS = 250;
const ADAPTER_POLL_MS = 2500;
// A session missing from the adapter's list, or 'working' without a process, may be starting or
// restarting; a 'waiting' one (its turn ended with a question nobody will answer, or it is
// rate-limited) may go on by itself. Each gets this long before it counts as ended.
const GRACE_MS = 60 * 1000;
const ENDED_STATES = ['done', 'stopped', 'failed'];
const NO_RESULT = 'crew session ended without a result';
const RETRY_INTERRUPTED = 'retry interrupted before its crew started';

// Without a snapshot, everything that exists is reported as new (from: null).
// lostSince keeps, per session, when it was first seen missing, without a process, or waiting; and,
// under the key task:<id>, when a running task was first seen without a session.
const EMPTY_SNAPSHOT = { tasks: {}, questions: {}, lostSince: {} };

function snapshotFile(name) {
  return path.join(missionDir(name), 'wait-snapshot.json');
}

// Judged on the state the adapter reports, never on the pid alone: a Claude session can be done
// with a live process, or working without one while it restarts. Only called for a task without a
// result: a crew waiting at this point has stopped short of `relaylead task done|fail`.
function crewEnded(shortId, session, lostSince, previousLostSince, now) {
  if (session && ENDED_STATES.includes(session.state)) return true;
  const lost = !session || (session.state === 'working' && !session.pid) || session.state === 'waiting';
  if (!lost) return false;
  return graceOver(shortId, lostSince, previousLostSince, now);
}

// Notes when `key` was first seen lost; true once it has been lost for the whole grace.
function graceOver(key, lostSince, previousLostSince, now) {
  lostSince[key] = previousLostSince[key] || new Date(now).toISOString();
  return now - Date.parse(lostSince[key]) >= GRACE_MS;
}

// The view of the mission at `now` (ms), and the tasks whose crew ended without a result (toFail),
// shown failed in the view already. Writes nothing: waitForChanges marks them failed, the watcher
// does it under the mission lock. `sessions` were listed before this call: a crew member writes its
// result before it ends, so when its session is seen ended there, its result is already visible in
// listTasks below. `lostSince` is when each session (or, under task:<id>, each running task without
// a session) was first seen lost; the one returned holds those still lost. `tasks` is listTasks.
function viewOf(name, sessions, lostSince, now) {
  const tasks = listTasks(name);
  const previous = lostSince || {};
  const stillLost = {};
  const toFail = [];
  for (const task of tasks) {
    if (task.state !== 'running') continue;
    // A retry between the change of attempt and its launch, or one a crash interrupted there. The
    // session stays null once failed: `relaylead task retry` launches the same attempt again.
    if (task.session === null) {
      if (graceOver(`task:${task.id}`, stillLost, previous, now)) toFail.push({ id: task.id, shortId: null, summary: RETRY_INTERRUPTED });
      continue;
    }
    const session = sessions.find((candidate) => candidate.shortId === task.session);
    if (crewEnded(task.session, session, stillLost, previous, now)) toFail.push({ id: task.id, shortId: task.session, summary: NO_RESULT });
  }
  const failing = new Set(toFail.map((one) => one.id));
  return {
    tasks,
    view: {
      tasks: Object.fromEntries(tasks.map((task) => [task.id, failing.has(task.id) ? 'failed' : task.state])),
      questions: Object.fromEntries(listQuestions(name).map((question) => [question.id, question.state])),
    },
    toFail,
    lostSince: stillLost,
  };
}

// The key of a view: the state and attempt of each task, the state of each question, keys sorted.
// A task failed again after a retry makes another key than its first failure.
function viewKeyOf(tasks, view) {
  const byId = [...tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify({
    questions: Object.fromEntries(Object.keys(view.questions).sort().map((id) => [id, view.questions[id]])),
    tasks: Object.fromEntries(byId.map((task) => [task.id, { attempt: task.attempt, state: view.tasks[task.id] }])),
  });
}

function readSnapshot(name) {
  return { ...EMPTY_SNAPSHOT, ...readJson(snapshotFile(name), {}) };
}

// What the next `relaylead wait` would report: the view compared to the last snapshot of wait.
// Writes nothing. `lostSince` is the caller's own (the watcher keeps it in watch.json).
function unseenChanges(name, sessions, lostSince, now) {
  const { tasks, view, toFail, lostSince: stillLost } = viewOf(name, sessions, lostSince, now);
  return { changes: diff(readSnapshot(name), view), viewKey: viewKeyOf(tasks, view), toFail, lostSince: stillLost };
}

function diff(before, after) {
  const changes = [];
  for (const [kind, key] of [['task', 'tasks'], ['question', 'questions']]) {
    const ids = new Set([...Object.keys(before[key]), ...Object.keys(after[key])]);
    for (const id of [...ids].sort()) {
      const from = id in before[key] ? before[key][id] : null;
      const to = id in after[key] ? after[key][id] : null;
      if (from !== to) changes.push({ kind, id, from, to });
    }
  }
  return changes;
}

// A finished task's crew session is stopped: a Claude session that is done keeps its process alive.
async function stopFinishedCrew(adapter, changes, tasks, sessions) {
  for (const change of changes) {
    if (change.kind !== 'task' || !['done', 'failed'].includes(change.to)) continue;
    const task = tasks.find((candidate) => candidate.id === change.id);
    const session = sessions.find((candidate) => candidate.shortId === task.session);
    if (session && session.state !== 'stopped') await adapter.stop(session);
  }
}

// Gives the changes since the last wait to `report` as soon as there is one, or [] after the timeout.
// The snapshot is saved only after `report` succeeds, so a change is never lost on the way out.
// `env` is the caller's: a lead replaced while it waits (relaunch, handover) gets not-current-lead at
// the next round, before anything is written or stopped.
async function waitForChanges(name, timeoutSeconds = DEFAULT_TIMEOUT_S, report = () => {}, { env } = {}) {
  const mission = readMission(name);
  const adapter = getAdapter(mission.agent);
  const snapshot = readSnapshot(name);
  const deadline = Date.now() + Math.min(timeoutSeconds, MAX_TIMEOUT_S) * 1000;
  let sessions = null;
  let listedAt = 0;
  for (;;) {
    if (sessions === null || Date.now() - listedAt >= ADAPTER_POLL_MS) {
      sessions = await adapter.list(name);
      listedAt = Date.now();
    }
    const refused = currentLeadError(name, env);
    if (refused) throw refused;
    const { tasks, view, toFail, lostSince } = viewOf(name, sessions, snapshot.lostSince, Date.now());
    // Checked after those reads: a stop is written before its sessions are killed, so a crew seen
    // ended by a stop is never taken for a crew failure. A wait left behind by a stopped lead ends here.
    if (getState(name) === 'stopped') throw codedError('mission-stopped', { mission: name });
    for (const one of toFail) markFailed(name, one.id, one.summary);
    const changes = diff(snapshot, view);
    if (changes.length > 0 || Date.now() >= deadline) {
      report(changes);
      await stopFinishedCrew(adapter, changes, tasks, sessions);
      // Checked again: a lead replaced during the stops leaves the changes to its successor's wait.
      const replaced = currentLeadError(name, env);
      if (replaced) throw replaced;
      writeJson(snapshotFile(name), { ...view, lostSince });
      return changes;
    }
    snapshot.lostSince = lostSince;
    await sleep(POLL_MS);
  }
}

module.exports = { waitForChanges, viewOf, unseenChanges };
