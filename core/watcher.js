// The watcher: a pass over every mission that is not finished. For each one it observes (observe,
// which writes nothing), decides by the pure rules of watcher-rules.js, then acts under the mission
// lock, after a second observation made under that lock. ~/.relaylead/STOP stops it from doing
// anything; ~/.relaylead/watcher.lock keeps one full pass at a time.
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { home, missionDir } = require('./paths');
const { readJson, writeJson, withWindowsRetry } = require('./store');
const { codedError } = require('./messages');
const { listSessions, isAlive } = require('./sessions');
const { readReadings } = require('./readings');
const { stopSessionsAndWait } = require('./missions');
const { listTasks } = require('./tasks');
const { writeJournal } = require('./guard');
const { withMissionLock, takeOverStaleLock, EMPTY_LOCK_STALE_MS } = require('./mission-lock');
const { sleep } = require('./timing');
const { watchLog, watchLogFile } = require('./watch-log');
const { decide, emptyWatch } = require('./watcher-rules');
const { getAdapter } = require('../adapters');

const FINISHED = ['done', 'stopped'];
// A pass lock older than this was left by a pass that is stuck: a pass takes seconds, a stop a few.
const PASS_LOCK_STALE_MS = 15 * 60 * 1000;
const LOG_MAX_BYTES = 1048576;
// The errors of a wait for a lock that gave up: the mission is left to the next pass.
const LOCK_GAVE_UP = ['start-busy', 'start-stuck', 'mission-unknown'];
// The second idle read of a lead that is working (measured fact 2). Read at each call: tests shorten it.
const idleRecheckMs = () => Number(process.env.RELAYLEAD_IDLE_RECHECK_MS) || 2000;

function missionFile(name, file) {
  return path.join(missionDir(name), file);
}

function stopFile() {
  return path.join(home(), 'STOP');
}

function passLockFile() {
  return path.join(home(), 'watcher.lock');
}

function stopPresent() {
  return fs.existsSync(stopFile());
}

// A line of `text` ("stop-extra-lead 1ead0001"): its first word is the action.
function logLine(name, text) {
  const space = text.indexOf(' ');
  if (space === -1) watchLog(name, text);
  else watchLog(name, text.slice(0, space), text.slice(space + 1));
}

function readState(name) {
  return readJson(missionFile(name, 'state.json'), { state: 'starting' });
}

function readWatch(name) {
  return { ...emptyWatch(), ...readJson(missionFile(name, 'watch.json'), {}) };
}

// The failures/ folder, every reading in it, registered session or not.
function readFailures(name) {
  const folder = missionFile(name, 'failures');
  let files;
  try {
    files = fs.readdirSync(folder);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  const failures = {};
  for (const file of files.filter((one) => one.endsWith('.json'))) {
    try {
      const failure = readJson(path.join(folder, file), null);
      if (failure) failures[file.slice(0, -'.json'.length)] = failure;
    } catch {
      // being written, or unreadable: no reading
    }
  }
  return failures;
}

async function listOrError(adapter, name) {
  try {
    return { rows: await adapter.list(name), listError: null };
  } catch (err) {
    return { rows: null, listError: err.message };
  }
}

function isIdleWorking(row) {
  return Boolean(row) && row.state === 'working' && row.idle === true && Boolean(row.pid);
}

// What the rules need to know of the mission now (watcher-rules.js). Writes nothing, logs nothing.
// Null for a finished mission, one being stopped (unless the breaker tripped: its stop is replayed),
// or one whose lead is being launched (no lead.json). A lead working and idle is read a second time,
// after RELAYLEAD_IDLE_RECHECK_MS: one idle read may be the start of a turn. The second list is kept.
async function observe(name) {
  const mission = readJson(missionFile(name, 'mission.json'), null);
  if (!mission) return null;
  const record = readState(name);
  const watch = readWatch(name);
  if (record.stopping ? !watch.tripped : FINISHED.includes(record.state)) return null;
  const lead = readJson(missionFile(name, 'lead.json'), null);
  if (!lead) return null;

  const adapter = getAdapter(mission.agent);
  let { rows, listError } = await listOrError(adapter, name);
  let leadIdleConfirmed = false;
  const leadRowOf = (list) => list.find((row) => row.shortId === lead.shortId);
  if (rows && isIdleWorking(leadRowOf(rows))) {
    await sleep(idleRecheckMs());
    const again = await listOrError(adapter, name);
    if (again.rows) {
      rows = again.rows;
      leadIdleConfirmed = isIdleWorking(leadRowOf(rows));
    }
  }
  let tasks = null;
  let tasksError = null;
  try {
    tasks = listTasks(name);
  } catch (err) {
    tasksError = err.message;
  }
  const registry = listSessions(name);
  const readings = {};
  for (const shortId of new Set([lead.shortId, ...registry.map((session) => session.shortId)])) {
    readings[shortId] = readReadings(name, shortId);
  }
  return {
    now: Date.now(),
    mission,
    record,
    lead,
    rows,
    listError,
    tasksError,
    leadIdleConfirmed,
    registry,
    tasks,
    readings,
    failures: readFailures(name),
    unseen: null,
    mail: {},
    config: mission.config,
    watch,
  };
}

// One action. `watch` is the object the decision returned, written once every action has run: an
// action may change it. A wait for a lock that gives up leaves the mission to the next pass; any
// other error is logged and does not keep the next actions from running.
async function act(name, action, watch) {
  try {
    if (action.type === 'log') {
      logLine(name, action.text);
      if (action.journal) writeJournal(name, 'watcher', action.text);
    } else if (action.type === 'stop-session') {
      logLine(name, action.log);
      await stopSession(name, action.session);
    } else {
      throw new Error(`unknown action ${action.type}`);
    }
  } catch (err) {
    if (LOCK_GAVE_UP.includes(err.code)) return;
    watchLog(name, 'error', `${action.type}: ${err.message}`);
  }
}

// Stops a session and waits for its end, in two steps (stopSessionsAndWait). Throws when the stop
// failed or the session still runs.
async function stopSession(name, session) {
  const mission = readJson(missionFile(name, 'mission.json'));
  const { failed, alive, error } = await stopSessionsAndWait(mission, [session]);
  if (failed.length > 0) throw error;
  if (alive.length > 0) throw codedError('session-still-alive', { mission: name, shortId: session.shortId });
}

// Tends one mission and returns the actions carried out. Nothing is locked or written when the rules
// have nothing to do. Otherwise, under the mission lock: nothing for a mission removed, launched
// again under the same name (another createdAt) or finished meanwhile; then a second observation,
// the only one the actions come from (it reads watch.json again), the actions, and watch.json.
// observe is read from module.exports, so a test can replace it.
async function tendMission(name) {
  const first = await module.exports.observe(name);
  if (!first) return [];
  const planned = decide(first);
  if (planned.actions.length === 0 && isDeepStrictEqual(planned.watch, first.watch)) return [];
  let decision;
  try {
    decision = await withMissionLock(name, 'watcher', () => tendLocked(name, first.mission.createdAt));
  } catch (err) {
    if (LOCK_GAVE_UP.includes(err.code)) return [];
    throw err;
  }
  if (!decision) return [];
  // An action marked afterLock takes the mission lock itself (a stop of the mission). It runs once
  // watch.json is written, so what it changes in `watch` is lost, and without reading createdAt
  // again: no action that writes into the mission folder (mail) may be one.
  for (const action of decision.actions.filter((one) => one.afterLock)) await act(name, action, decision.watch);
  return decision.actions;
}

// The decision {actions, watch} under the lock, its actions carried out but those marked afterLock;
// null when there is nothing to do.
async function tendLocked(name, createdAt) {
  const mission = readJson(missionFile(name, 'mission.json'), null);
  if (!mission || mission.createdAt !== createdAt) return null;
  // STOP may have come while this pass waited for the lock.
  if (stopPresent()) return null;
  const record = readState(name);
  if (FINISHED.includes(record.state) && !record.stopping) return null;
  const obs = await module.exports.observe(name);
  if (!obs) return null;
  const decision = decide(obs);
  for (const action of decision.actions.filter((one) => !one.afterLock)) await act(name, action, decision.watch);
  if (!isDeepStrictEqual(decision.watch, obs.watch)) writeJson(missionFile(name, 'watch.json'), decision.watch, { createDir: false });
  return decision;
}

// The names of the mission folders, whether their mission.json can be read or not: one that
// cannot is reported by its pass, and does not hide the others.
function missionNames() {
  try {
    return fs
      .readdirSync(path.join(home(), 'missions'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[a-z0-9-]+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// Whether a mission is to be watched: neither finished nor being stopped. Throws when its
// mission.json cannot be read.
function needsWatching(name) {
  if (!readJson(missionFile(name, 'mission.json'), null)) return false;
  const record = readState(name);
  return !FINISHED.includes(record.state) && !record.stopping;
}

// {pid, since} of the pass lock, or null once it is gone; pid 0 while it is being written.
function readPassLock() {
  let text;
  try {
    text = fs.readFileSync(passLockFile(), 'utf8');
  } catch {
    return null;
  }
  try {
    const lock = JSON.parse(text);
    return { pid: Number(lock.pid) || 0, since: lock.since || '?' };
  } catch {
    return { pid: 0, since: '?' };
  }
}

// Stale: its pass is dead, or older than 15 min, or nothing could be read from it for 10 s (a pass
// that died between creating the file and writing it). A lock that is gone is not stale.
function isStalePassLock() {
  const lock = readPassLock();
  if (!lock) return false;
  if (!lock.pid) {
    let modifiedAt;
    try {
      modifiedAt = fs.statSync(passLockFile()).mtimeMs;
    } catch {
      return false;
    }
    return Date.now() - modifiedAt > EMPTY_LOCK_STALE_MS;
  }
  const since = Date.parse(lock.since);
  return !isAlive(lock.pid) || !(Date.now() - since <= PASS_LOCK_STALE_MS);
}

// Creating the file with 'wx' fails if it exists. On Windows, a lock file being deleted cannot be
// created again for a moment (EPERM): it counts as still held.
function tryCreatePassLock(lock) {
  try {
    fs.mkdirSync(home(), { recursive: true });
    fs.writeFileSync(passLockFile(), JSON.stringify(lock), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST' || (process.platform === 'win32' && err.code === 'EPERM')) return false;
    throw err;
  }
}

async function takePassLock(lock) {
  if (tryCreatePassLock(lock)) return true;
  return isStalePassLock() && (await takeOverStaleLock(passLockFile(), isStalePassLock)) && tryCreatePassLock(lock);
}

// Only while it is still ours: a pass that took it over (ours being older than 15 min) keeps its own.
// Under the takeover guard, so a takeover running now is not crossed; tried twice, as releaseLock.
async function releasePassLock(lock) {
  const ours = () => {
    const current = readPassLock();
    return Boolean(current) && current.pid === lock.pid && current.since === lock.since;
  };
  for (let attempt = 1; attempt <= 2 && ours(); attempt++) {
    if (await takeOverStaleLock(passLockFile(), ours)) return;
  }
}

// Past 1 MiB, the log moves to watcher.log.1, over the previous one.
function rotateLog() {
  let size;
  try {
    size = fs.statSync(watchLogFile()).size;
  } catch {
    return;
  }
  if (size <= LOG_MAX_BYTES) return;
  try {
    withWindowsRetry(() => fs.renameSync(watchLogFile(), `${watchLogFile()}.1`));
  } catch {
    // The log is a record only: the pass goes on, and the next one moves it.
  }
}

// A full pass: {outcome: 'done', missions} where missions counts the missions to watch, or
// {outcome: 'stop'} while STOP is present, also when it comes during the pass (read again before
// each mission), {outcome: 'busy', holder} while another pass holds the lock, both with missions 0.
// tendMission is read from module.exports, so a test can replace it.
async function runPass() {
  if (stopPresent()) return { outcome: 'stop', missions: 0 };
  const lock = { pid: process.pid, since: new Date().toISOString() };
  if (!(await takePassLock(lock))) return { outcome: 'busy', missions: 0, holder: readPassLock() || { pid: '?', since: '?' } };
  try {
    rotateLog();
    let missions = 0;
    for (const name of missionNames()) {
      if (stopPresent()) return { outcome: 'stop', missions: 0 };
      try {
        if (needsWatching(name)) missions++;
        await module.exports.tendMission(name);
      } catch (err) {
        watchLog(name, 'error', `observe ${name}: ${err.message}`);
      }
    }
    return { outcome: 'done', missions };
  } finally {
    await releasePassLock(lock);
  }
}

module.exports = { observe, act, tendMission, runPass, stopPresent };
