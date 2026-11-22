// The places of the machine: at most maxSessions crew members work at a time, every mission included.
// The leads do not count, so each mission can always move and ask its questions. A task that finds no
// place waits in the queue: its record tasks/<id>.json is `queued`. The watcher starts the queued tasks
// as places free up (core/tasks.js startQueued): the most urgent mission first (its priority), then
// the task queued first. Nothing running is ever stopped to make room.
// Counted on the task records, never by asking the agent: a task holds a place while it is `running`
// and its crew member has not written its result yet.
const fs = require('node:fs');
const path = require('node:path');
const { home, missionDir } = require('./paths');
const { readJson } = require('./store');
const { loadConfig, DEFAULTS } = require('./config');
const { readPause } = require('./usage-pause');

const PRIORITIES = ['high', 'normal', 'low'];
const FINISHED = ['done', 'stopped'];

// The ceiling of the machine file (~/.relaylead/config.json); a whole number of at least 1, otherwise 4.
function maxSessions() {
  const value = loadConfig().maxSessions;
  return Number.isInteger(value) && value >= 1 ? value : DEFAULTS.maxSessions;
}

// 0 for high, 1 for normal, 2 for low; an unknown priority counts as normal.
function rank(priority) {
  const index = PRIORITIES.indexOf(priority);
  return index === -1 ? 1 : index;
}

function readQuietly(file) {
  try {
    return readJson(file, null);
  } catch {
    return null; // being written: the next look reads it
  }
}

// The missions whose tasks may hold or wait for a place: neither finished nor paused for the usage
// limit; a finished one only while a crew member resolves the conflict of its merge (core/merge.js).
function missionsWithPlaces() {
  let names;
  try {
    names = fs.readdirSync(path.join(home(), 'missions'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const missions = [];
  for (const name of names) {
    const mission = readQuietly(path.join(missionDir(name), 'mission.json'));
    if (!mission) continue;
    const record = readQuietly(path.join(missionDir(name), 'state.json')) || { state: 'starting' };
    const merge = readQuietly(path.join(missionDir(name), 'merge.json'));
    const open = !FINISHED.includes(record.state) && !record.stopping;
    const merging = record.state === 'done' && !record.stopping && Boolean(merge) && merge.state === 'resolving';
    if ((open || merging) && !readPause(name)) missions.push(mission);
  }
  return missions;
}

// The task records of a mission, each with its crew's result: [{record, result}].
function taskRecords(name) {
  const folder = path.join(missionDir(name), 'tasks');
  let files;
  try {
    files = fs.readdirSync(folder);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return files
    .filter((file) => file.endsWith('.json') && !file.endsWith('.result.json'))
    .map((file) => {
      const record = readQuietly(path.join(folder, file));
      const result = record ? readQuietly(path.join(folder, `${record.id}.result.json`)) : null;
      return { record, result };
    })
    .filter(({ record }) => record && record.id);
}

// Running: its crew member has not reported the current attempt yet.
function holdsPlace({ record, result }) {
  if (record.state !== 'running') return false;
  return !(result && (result.attempt || 1) === (record.attempt || 1));
}

// The places taken now. `except` ({mission, id}) leaves out a task taking up its own place (a retry).
function placesTaken(except = null) {
  let taken = 0;
  for (const mission of missionsWithPlaces()) {
    for (const entry of taskRecords(mission.name)) {
      if (except && except.mission === mission.name && except.id === entry.record.id) continue;
      if (holdsPlace(entry)) taken++;
    }
  }
  return taken;
}

// The queued tasks, the first to start first: [{mission, id, priority, queuedAt}].
function queue() {
  const entries = [];
  for (const mission of missionsWithPlaces()) {
    for (const { record } of taskRecords(mission.name)) {
      if (record.state !== 'queued') continue;
      entries.push({ mission: mission.name, id: record.id, priority: mission.priority || 'normal', queuedAt: record.queuedAt || '' });
    }
  }
  return entries.sort((a, b) => rank(a.priority) - rank(b.priority) || (a.queuedAt < b.queuedAt ? -1 : a.queuedAt > b.queuedAt ? 1 : 0));
}

// The number of queued tasks of one mission, for the displays.
function queuedCount(name) {
  return taskRecords(name).filter(({ record }) => record.state === 'queued').length;
}

// Whether task `id` of `mission` may take a place now: one is free, and no queued task comes before
// it (as urgent or more, so queued earlier). `fromQueue`: the watcher picked it at the head of the queue.
// Called under the places lock.
function placeFree(mission, id, { fromQueue = false } = {}) {
  if (placesTaken({ mission: mission.name, id }) >= maxSessions()) return false;
  if (fromQueue) return true;
  const own = rank(mission.priority);
  return !queue().some((entry) => !(entry.mission === mission.name && entry.id === id) && rank(entry.priority) <= own);
}

module.exports = { PRIORITIES, maxSessions, placesTaken, queue, queuedCount, placeFree };
