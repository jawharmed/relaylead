// `relaylead wait`: blocks the lead until its mission changes, then says what changed.
// The last view is kept in wait-snapshot.json, so a change made while nobody waits is reported by the next wait.
const path = require('node:path');
const { missionDir } = require('./paths');
const { writeJson, readJson } = require('./store');
const { readMission, getState } = require('./missions');
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

// Without a snapshot, everything that exists is reported as new (from: null).
// lostSince keeps, per session, when it was first seen missing, without a process, or waiting.
const EMPTY_SNAPSHOT = { tasks: {}, questions: {}, sessions: {}, lostSince: {} };

function snapshotFile(name) {
  return path.join(missionDir(name), 'wait-snapshot.json');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Judged on the state the adapter reports, never on the pid alone: a Claude session can be done
// with a live process, or working without one while it restarts. Only called for a task without a
// result: a crew waiting at this point has stopped short of `relaylead task done|fail`.
function crewEnded(shortId, session, lostSince, previousLostSince) {
  if (session && ENDED_STATES.includes(session.state)) return true;
  const lost = !session || (session.state === 'working' && !session.pid) || session.state === 'waiting';
  if (!lost) return false;
  lostSince[shortId] = previousLostSince[shortId] || new Date().toISOString();
  return Date.now() - Date.parse(lostSince[shortId]) >= GRACE_MS;
}

// The current view of the mission, after marking the tasks whose crew ended without a result.
// `sessions` were listed before this call: a crew member writes its result before it ends, so when
// its session is seen ended there, its result is already visible in listTasks below.
function look(name, sessions, previousLostSince) {
  const tasks = listTasks(name);
  // Checked after those reads: a stop is written before its sessions are killed, so a crew seen
  // ended by a stop is never taken for a crew failure. A wait left behind by a stopped lead ends here.
  if (getState(name) === 'stopped') throw codedError('mission-stopped', { mission: name });
  const lostSince = {};
  for (const task of tasks) {
    if (task.state !== 'running') continue;
    const session = sessions.find((candidate) => candidate.shortId === task.session);
    if (crewEnded(task.session, session, lostSince, previousLostSince)) {
      markFailed(name, task.id, NO_RESULT);
      task.state = 'failed';
    }
  }
  return {
    tasks,
    view: {
      tasks: Object.fromEntries(tasks.map((task) => [task.id, task.state])),
      questions: Object.fromEntries(listQuestions(name).map((question) => [question.id, question.state])),
      sessions: Object.fromEntries(sessions.map((session) => [session.shortId, session.state])),
      lostSince,
    },
  };
}

function diff(before, after) {
  const changes = [];
  for (const [kind, key] of [['task', 'tasks'], ['question', 'questions'], ['session', 'sessions']]) {
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
async function waitForChanges(name, timeoutSeconds = DEFAULT_TIMEOUT_S, report = () => {}) {
  const mission = readMission(name);
  const adapter = getAdapter(mission.agent);
  const snapshot = { ...EMPTY_SNAPSHOT, ...readJson(snapshotFile(name), {}) };
  const deadline = Date.now() + Math.min(timeoutSeconds, MAX_TIMEOUT_S) * 1000;
  let sessions = null;
  let listedAt = 0;
  for (;;) {
    if (sessions === null || Date.now() - listedAt >= ADAPTER_POLL_MS) {
      sessions = await adapter.list(name);
      listedAt = Date.now();
    }
    const { tasks, view } = look(name, sessions, snapshot.lostSince);
    const changes = diff(snapshot, view);
    if (changes.length > 0 || Date.now() >= deadline) {
      report(changes);
      await stopFinishedCrew(adapter, changes, tasks, sessions);
      writeJson(snapshotFile(name), view);
      return changes;
    }
    snapshot.lostSince = view.lostSince;
    await sleep(POLL_MS);
  }
}

module.exports = { waitForChanges };
