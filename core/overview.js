// What the three displays show (the Claude Code status line and pane, `relaylead dashboard`): one
// view of every mission of the machine, built from the files of ~/.relaylead. It writes nothing and
// calls no network: a mission whose tasks come from GitHub shows the tasks that have a record.
const fs = require('node:fs');
const path = require('node:path');
const { missionDir } = require('./paths');
const { readJson } = require('./store');
const { loadConfig } = require('./config');
const { listMissions, readMission, awaitsMerge } = require('./missions');
const { listTasks } = require('./tasks');
const { listQuestions } = require('./questions');
const { readPause } = require('./usage-pause');
const { usageFile, isFresh } = require('./usage');
const { placesTaken, maxSessions, queuedCount } = require('./places');

const FINISHED = /^(done|stopped)/;

// Tasks of a mission as {id, title, state}. tasks-dir reads its folder; the other sources are only
// known by the records of the tasks started.
function tasksOf(name, mission) {
  if (mission.config.source.type === 'tasks-dir') {
    return listTasks(name).map((task) => ({ id: task.id, title: task.title, state: task.state }));
  }
  const dir = path.join(missionDir(name), 'tasks');
  return fs
    .readdirSync(dir)
    .filter((file) => /^[^.]+\.json$/.test(file))
    .map((file) => readJson(path.join(dir, file), null))
    .filter(Boolean)
    .map((record) => ({ id: record.id, title: record.id, state: record.state }));
}

// A reading that fails (a source folder gone, a half-written file) leaves its part empty: the
// displays must not stop for one broken mission.
function attempt(action, fallback) {
  try {
    return action();
  } catch {
    return fallback;
  }
}

function missionView(listed) {
  const { name } = listed;
  const mission = attempt(() => readMission(name), null);
  if (!mission) return null;
  const finished = FINISHED.test(listed.state);
  const pause = finished ? null : readPause(name);
  return {
    name,
    dir: mission.dir,
    priority: mission.priority || 'normal',
    state: listed.state,
    active: !finished,
    // Done, and its work not brought into the user's branch yet: `relaylead merge <mission>`.
    toMerge: attempt(() => awaitsMerge(mission), false),
    pausedUntil: pause ? pause.resumeAt : null,
    // Tasks waiting for a free place on the machine (core/places.js).
    queued: finished ? 0 : attempt(() => queuedCount(name), 0),
    tasks: attempt(() => tasksOf(name, mission), []),
    // Also for a finished mission: the question of a merge conflict is asked once the mission is done.
    questions: attempt(() => listQuestions(name, { state: 'open' }), []).map((question) => ({
      id: question.id,
      text: question.text,
      context: question.context,
      options: question.options,
      recommended: question.recommended,
      askedAt: question.askedAt,
    })),
  };
}

// The usage of the account as the sessions measured it, or null when there is no reading or it is
// older than 30 min.
function usageView() {
  const claude = attempt(() => readJson(usageFile(), {}), {}).claude;
  if (!isFresh(claude, Date.now())) return null;
  return { at: claude.at, fiveHour: claude.fiveHour || null, sevenDay: claude.sevenDay || null };
}

function buildOverview() {
  const config = loadConfig();
  const missions = listMissions().map(missionView).filter(Boolean);
  return {
    generatedAt: new Date().toISOString(),
    language: config.language,
    display: config.display,
    usage: usageView(),
    // The crew members working on the machine, and the ceiling (maxSessions).
    sessions: { running: attempt(() => placesTaken(), 0), max: maxSessions() },
    missions,
    activeMissions: missions.filter((mission) => mission.active).length,
    openQuestions: missions.reduce((sum, mission) => sum + mission.questions.length, 0),
  };
}

module.exports = { buildOverview };
