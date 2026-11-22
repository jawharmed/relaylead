// The watcher: a pass over every mission that is not finished. For each one it observes (observe,
// which writes nothing), decides by the pure rules of watcher-rules.js, then acts under the mission
// lock, after a second observation made under that lock. ~/.relaylead/STOP stops it from doing
// anything; ~/.relaylead/watcher.lock keeps one full pass at a time. The loop (`relaylead watcher
// loop`, started by `relaylead watcher start` and by `relaylead launch`) runs a full pass every
// watcher.everySeconds seconds, and ends once no mission needs it.
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { home, missionDir } = require('./paths');
const { readJson, writeJson, writeText, withWindowsRetry } = require('./store');
const { codedError } = require('./messages');
const { watcherSettings } = require('./config');
const { spawnDetached } = require('./detached');
const { listSessions, recordSession, isAlive } = require('./sessions');
const { readReadings } = require('./readings');
const { readUsage } = require('./usage');
const { readPause, writePause, removePause } = require('./usage-pause');
const missions = require('./missions');
const { stopSessionsAndWait, launchLead, launchWhileOpen, writeState } = missions;
const { listTasks, markFailed, startQueued } = require('./tasks');
const { unseenChanges } = require('./wait');
const { unreadCount, sendMail } = require('./mailbox');
const { writeJournal } = require('./guard');
const { listQuestions, answerQuestion } = require('./questions');
const { notify } = require('./notify');
const { withMissionLock, takeOverStaleLock, EMPTY_LOCK_STALE_MS } = require('./mission-lock');
const { sleep } = require('./timing');
const { watchLog, watchLogFile } = require('./watch-log');
const { decide, emptyWatch, wakeWithoutEffect } = require('./watcher-rules');
const { lastActivity } = require('./abandon');
const { tendMerge, mergeOngoing } = require('./merge');
const { getAdapter } = require('../adapters');

const FINISHED = ['done', 'stopped'];
// A pass lock older than this was left by a pass that is stuck: a pass takes seconds, a stop a few.
const PASS_LOCK_STALE_MS = 15 * 60 * 1000;
const LOG_MAX_BYTES = 1048576;
// The errors of a wait for a lock that gave up: the mission is left to the next pass.
const LOCK_GAVE_UP = ['start-busy', 'start-stuck', 'mission-unknown'];
// The loop writes its beat this often; a loop file whose beat is older than LOOP_RUNNING_MS is that of
// a loop that is gone (killed, or the machine restarted). Never judged on its pid (#62).
const LOOP_BEAT_MS = 30 * 1000;
const LOOP_RUNNING_MS = 90 * 1000;
// Between two passes, the loop checks every LOOP_STEP_MS whether it must end.
const LOOP_STEP_MS = 1000;
const START_WAIT_MS = 5000;
// The file of a test run (RELAYLEAD_TEST_RUN_FILE) is refreshed every 10 s while the run lives.
const TEST_RUN_STALE_MS = 60 * 1000;
const STOP_WAIT_MS = 10000;
// The second idle read of a lead that is working (measured fact 2). Read at each call: tests shorten it.
const idleRecheckMs = () => Number(process.env.RELAYLEAD_IDLE_RECHECK_MS) || 2000;
// A patient pass looks again this often, for this long at most. Read at each call: tests shorten them.
const helperRecheckMs = () => Number(process.env.RELAYLEAD_HELPER_RECHECK_MS) || 5000;
const helperPatienceMs = () => Number(process.env.RELAYLEAD_HELPER_PATIENCE_MS) || 60000;

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
  const now = Date.now();
  // What the lead has not seen, whatever its state (wait.js, which writes nothing); null leaves rules
  // 5 and 14 out of this pass. A mission stopping after its breaker tripped has only its stop to replay.
  let unseen = null;
  if (rows && tasks && !record.stopping) {
    try {
      unseen = unseenChanges(name, rows, watch.crewLostSince, now);
    } catch (err) {
      tasksError = err.message;
    }
  }
  const registry = listSessions(name);
  const readings = {};
  for (const shortId of new Set([lead.shortId, ...registry.map((session) => session.shortId)])) {
    readings[shortId] = readReadings(name, shortId);
  }
  // The unread mail of each listed session, and of the lead even when it is not listed: a wake works
  // on a stopped session.
  const mail = {};
  for (const shortId of new Set([lead.shortId, ...(rows || []).map((row) => row.shortId)])) {
    mail[shortId] = unreadCount(name, shortId);
  }
  // The open questions, for rule 30; null when one cannot be read.
  let questions = null;
  try {
    questions = listQuestions(name, { state: 'open' });
  } catch {
    // being written, or unreadable: rule 30 waits for the next pass
  }
  return {
    now,
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
    unseen,
    mail,
    // The usage limits are those of Claude Code alone in this version, which the fake agent plays too.
    usage: readUsage('claude', now),
    pause: readPause(name),
    config: mission.config,
    watch,
    questions,
    lastActivityAt: lastActivity(name),
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
    } else if (action.type === 'mark-failed') {
      logLine(name, action.log);
      markFailed(name, action.id, action.summary);
    } else if (action.type === 'wake-lead') {
      logLine(name, action.log);
      await wakeLead(name, action.reasons, watch);
    } else if (action.type === 'relaunch-lead') {
      await relaunchLead(name, action.resume, watch);
    } else if (action.type === 'trip-breaker') {
      await tripBreaker(name, action.note);
    } else if (action.type === 'hand-over') {
      await handOver(name, action, watch);
    } else if (action.type === 'mail') {
      logLine(name, action.log);
      sendMail(name, action.shortId, action.text);
    } else if (action.type === 'answer-question') {
      answerQuestion(name, action.id, action.choice); // throws when the user answered meanwhile
      logLine(name, action.log);
      writeJournal(name, 'watcher', action.log);
    } else if (action.type === 'notify') {
      logLine(name, action.log);
      notify({ title: `Relaylead: ${name}`, text: action.text });
    } else if (action.type === 'remind-question') {
      logLine(name, action.log);
      notify({ title: `Relaylead: ${name}`, text: action.text });
    } else if (action.type === 'pause-mission') {
      logLine(name, action.log);
      writePause(name, action);
      if (action.wake) await wakeLead(name, ['usage'], watch, USAGE_TEXT);
    } else if (action.type === 'resume-mission') {
      logLine(name, action.log);
      removePause(name);
    } else {
      throw new Error(`unknown action ${action.type}`);
    }
  } catch (err) {
    if (LOCK_GAVE_UP.includes(err.code)) return;
    watchLog(name, 'error', `${action.type}: ${err.message}`);
  }
}

// The text of a wake ("Textes envoyés aux sessions").
function wakeText(reasons) {
  return `Relaylead woke you: ${reasons.join('; ')}. Carry on with the method: run \`relaylead task list\` first.`;
}

// The text of the wake that pauses a mission for the usage limit.
const USAGE_TEXT = 'Usage limit near: commit and push your work, write your state, end your turn.';

// Wakes the current lead (lead.json) and records the woken session; `text` is that of a wake for
// these reasons, unless given. A wake that throws is a wake without effect: its motive is due again,
// after the backoff. A lead woken is no longer lost: its next loss gets a whole grace.
async function wakeLead(name, reasons, watch, text = wakeText(reasons)) {
  try {
    const mission = readJson(missionFile(name, 'mission.json'));
    const lead = readJson(missionFile(name, 'lead.json'));
    const session = listSessions(name).find((candidate) => candidate.shortId === lead.shortId);
    if (!session) throw new Error(`the lead ${lead.shortId} is not in the registry`);
    const woken = await getAdapter(mission.agent).wake(session, text);
    recordSession(name, woken);
    watch.leadLostSince = null;
  } catch (err) {
    Object.assign(watch, wakeWithoutEffect(watch, Date.now()));
    throw err;
  }
}

const BREAKER_NOTE = 'stopped by the watcher: the lead could not be restarted 3 times in a row';

// Rules 4b and 8, after the mission lock: stopMission takes it itself. stopMission is read from the
// module object, so a test can replace it. A stop that throws is replayed at the next pass (rule 1).
// Once stopped, the user is told, once: the mission waits for them.
async function tripBreaker(name, note = BREAKER_NOTE) {
  await missions.stopMission(name, { note });
  writeJournal(name, 'watcher', note);
  watchLog(name, 'breaker-stopped', note);
  notify({ title: `Relaylead: ${name}`, text: note });
}

const RESTART_TEXT = 'Relaylead restarted you after your session ended. Carry on with the method: run `relaylead task list` first.';

// The section a new lead gets before the mission after a relaunch ("## Restart").
function restartSection(old) {
  return `## Restart\n\nThe previous lead session ${old} ended unexpectedly. You take its place: you remember nothing, the files hold everything. Start with \`relaylead task list\`, then \`relaylead memory show\`.`;
}

// What the watcher remembers of the wakes of a lead: forgotten when the lead changes.
const WAKE_MEMORY = { lastWakeAt: null, lastWakeView: null, interruptWakeFor: null, ineffectiveWakes: 0 };

// The breaker's count after a relaunch or a handover that threw ("Décompte du disjoncteur", b).
function countFailedRelaunch(watch) {
  watch.failedRelaunches += 1;
  watch.lastFailedRelaunchAt = new Date().toISOString();
  watch.lastRelaunchAt = null;
}

// Rule 10: the absent lead is resumed (`resume`: the same session, woken with RESTART_TEXT), or, when
// that throws or is not to be tried, replaced by a new lead session with the ## Restart section. All
// within launchWhileOpen: a stop that comes meanwhile stops the session launched. A mission stopped or
// done meanwhile: nothing more, and nothing counted. lastLeadActionAt is set at the start: a relaunch
// that throws then counts as a wake without effect too, at the next judgement of the wakes.
async function relaunchLead(name, resume, watch) {
  const startedAt = new Date().toISOString();
  watch.lastRelaunchAt = startedAt;
  watch.lastLeadActionAt = startedAt;
  const mission = readJson(missionFile(name, 'mission.json'));
  const old = readJson(missionFile(name, 'lead.json'));
  const adapter = getAdapter(mission.agent);
  let resumed = false;
  const launch = async () => {
    if (resume) {
      try {
        const session = listSessions(name).find((candidate) => candidate.shortId === old.shortId);
        if (!session) throw new Error(`the lead ${old.shortId} is not in the registry`);
        const woken = await adapter.wake(session, RESTART_TEXT);
        recordSession(name, woken);
        resumed = true;
        return woken;
      } catch (err) {
        watchLog(name, 'error', `resume-lead: ${err.message}`);
      }
    }
    return launchLead(mission, { section: restartSection(old.sessionName) });
  };
  let session;
  try {
    session = await launchWhileOpen(name, launch, (launched) => stopSessionsAndWait(mission, [launched]));
  } catch (err) {
    if (['mission-stopped', 'mission-done'].includes(err.code)) return;
    countFailedRelaunch(watch);
    throw err;
  }
  watch.leadLostSince = null;
  if (!resumed) Object.assign(watch, WAKE_MEMORY);
  watchLog(name, 'relaunch-lead', resumed ? `${old.shortId} resumed` : `${old.shortId} as ${session.name}`);
}

// The section a new lead gets before the mission after a handover ("## Handover").
function handoverSection(old, reason, note) {
  const how = {
    asked: `which handed over with this note: ${note || '-'}`,
    forced: 'which handed over when its context was full',
    idle: 'which was idle past its context threshold',
  }[reason];
  return `## Handover\n\nYou take over from the lead session ${old}, ${how}. You remember nothing, the files hold everything. Start with \`relaylead task list\`, then \`relaylead memory show\`.`;
}

// Rules 9, 12 and 13: the old lead is stopped if it has a process, `starting` is written (before the
// launch: the new lead acts before launch returns, and its `working` must not be erased), then the next
// lead is launched within launchWhileOpen, which stops it if a stop came meanwhile. A mission finished,
// stopped or being stopped: nothing. A handover that throws otherwise counts for the breaker, and the
// state it found is written back, so the handover is tried again. lastLeadActionAt is set at the start:
// a handover that throws then counts as a wake without effect too, at the next judgement of the wakes.
async function handOver(name, { reason, note, tokens }, watch) {
  const startedAt = new Date().toISOString();
  watch.lastRelaunchAt = startedAt;
  watch.lastLeadActionAt = startedAt;
  const record = readState(name);
  if (FINISHED.includes(record.state) || record.stopping) return;
  const mission = readJson(missionFile(name, 'mission.json'));
  const old = readJson(missionFile(name, 'lead.json'));
  const stop = (launched) => stopSessionsAndWait(mission, [launched]);
  const detail = { asked: note || '-', forced: `forced at ${tokens} tokens`, idle: 'idle past the soft threshold' }[reason];
  let session;
  try {
    const oldSession = listSessions(name).find((candidate) => candidate.shortId === old.shortId);
    const rows = await getAdapter(mission.agent).list(name);
    if (oldSession && rows.some((row) => row.shortId === old.shortId && row.pid)) await stopSession(name, oldSession);
    const now = readState(name);
    if (FINISHED.includes(now.state) || now.stopping) return;
    writeState(name, { state: 'starting', note: `taken over from ${old.sessionName}: ${detail}` });
    session = await launchWhileOpen(name, () => launchLead(mission, { section: handoverSection(old.sessionName, reason, note) }), stop);
  } catch (err) {
    if (['mission-stopped', 'mission-done'].includes(err.code)) return;
    countFailedRelaunch(watch);
    const now = readState(name);
    if (now.state === 'starting' && !now.stopping) writeJson(missionFile(name, 'state.json'), record);
    throw err;
  }
  watch.handoverNoticeFor = null;
  watch.leadLostSince = null;
  Object.assign(watch, WAKE_MEMORY);
  watchLog(name, 'hand-over', `${old.sessionName} to ${session.name}: ${detail}`);
}

// Stops a session and waits for its end, in two steps (stopSessionsAndWait). Throws when the stop
// failed or the session still runs.
async function stopSession(name, session) {
  const mission = readJson(missionFile(name, 'mission.json'));
  const { failed, alive, error } = await stopSessionsAndWait(mission, [session]);
  if (failed.length > 0) throw error;
  if (alive.length > 0) throw codedError('session-still-alive', { mission: name, shortId: session.shortId });
}

// Tends one mission and returns the actions carried out. A patient pass (a targeted one, `watcher run
// --mission`) looks again every RELAYLEAD_HELPER_RECHECK_MS while the rules ask for it (decide's
// `again`: a lead still finishing its turn with something to wake it for, a wake held by the quiet
// time), RELAYLEAD_HELPER_PATIENCE_MS at most, without holding the lock between two looks.
async function tendMission(name, { patient = false } = {}) {
  const giveUpAt = Date.now() + helperPatienceMs();
  const done = [];
  for (;;) {
    const { actions, again } = await tendOnce(name);
    done.push(...actions);
    if (!patient || !again || Date.now() + helperRecheckMs() > giveUpAt) return done;
    await sleep(helperRecheckMs());
  }
}

// One look at a mission: {actions carried out, again}. Nothing is locked or written when the rules
// have nothing to do. Otherwise, under the mission lock: nothing for a mission removed, launched
// again under the same name (another createdAt) or finished meanwhile; then a second observation,
// the only one the actions come from (it reads watch.json again), the actions, and watch.json.
// observe is read from module.exports, so a test can replace it.
async function tendOnce(name) {
  const nothing = { actions: [], again: false };
  const first = await module.exports.observe(name);
  if (!first) return nothing;
  const planned = decide(first);
  if (planned.actions.length === 0 && isDeepStrictEqual(planned.watch, first.watch)) return { actions: [], again: planned.again };
  let decision;
  try {
    decision = await withMissionLock(name, 'watcher', () => tendLocked(name, first.mission.createdAt));
  } catch (err) {
    if (LOCK_GAVE_UP.includes(err.code)) return nothing;
    throw err;
  }
  if (!decision) return nothing;
  // An action marked afterLock takes the mission lock itself (a stop of the mission). It runs once
  // watch.json is written, so what it changes in `watch` is lost, and without reading createdAt
  // again: no action that writes into the mission folder (mail) may be one.
  for (const action of decision.actions.filter((one) => one.afterLock)) await act(name, action, decision.watch);
  return { actions: decision.actions, again: decision.again };
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

// Whether a mission is to be watched: neither finished nor being stopped, unless the stop is that of
// its breaker, to be replayed; or done with a merge conflict being resolved (core/merge.js). Throws
// when its mission.json cannot be read.
function needsWatching(name) {
  if (!readJson(missionFile(name, 'mission.json'), null)) return false;
  const record = readState(name);
  if (record.stopping) return readWatch(name).tripped; // the stop of its breaker is to be replayed
  if (record.state === 'done' && mergeOngoing(name)) return true;
  return !FINISHED.includes(record.state);
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
      await tendMergeOf(name);
    }
    await startQueuedTasks();
    return { outcome: 'done', missions };
  } finally {
    await releasePassLock(lock);
  }
}

// The merge of a finished mission whose conflict is being resolved (core/merge.js). A wait for a lock
// that gives up leaves it to the next pass; any other error goes to the log.
async function tendMergeOf(name) {
  try {
    await tendMerge(name);
  } catch (err) {
    if (!LOCK_GAVE_UP.includes(err.code)) watchLog(name, 'error', `merge: ${err.message}`);
  }
}

// After a pass, full or targeted: the queued tasks take the places freed meanwhile (core/places.js),
// unless STOP is there. Each start, and each start that failed, goes to the log.
async function startQueuedTasks() {
  if (stopPresent()) return;
  const onError = (entry, err) => watchLog(entry.mission, 'error', `queue-start ${entry.id}: ${err.message}`);
  for (const entry of await startQueued({ onError })) watchLog(entry.mission, 'queue-start', entry.id);
}

// The missions to watch now, neither finished nor being stopped, being launched included. One whose
// mission.json cannot be read is not counted, and does not keep the others from being counted.
function missionsToWatch() {
  return missionNames().filter((name) => {
    try {
      return needsWatching(name);
    } catch {
      return false;
    }
  }).length;
}

function loopFile() {
  return path.join(home(), 'watcher-loop.json');
}

function loopStopFile() {
  return path.join(home(), 'watcher-loop.stop');
}

// {pid, startedAt, version, beatAt, lastPassAt, everySeconds}, or null when there is none (or it
// cannot be read: it is written by rename, so only a broken disk does that).
function readLoopFile() {
  try {
    return readJson(loopFile(), null);
  } catch {
    return null;
  }
}

// pid and startedAt are the token of a loop: the file is that loop's.
function isOurs(loop, token) {
  return Boolean(loop) && loop.pid === token.pid && loop.startedAt === token.startedAt;
}

function removeFile(file) {
  try {
    withWindowsRetry(() => fs.rmSync(file, { force: true }));
  } catch {
    // left behind: the next start, or the next loop, deals with it
  }
}

// The version of package.json as it is on the disk now: an update of the package changes it under a
// running loop. A package.json that cannot be read (being replaced) counts as another version.
function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

// RELAYLEAD_TEST_RUN_FILE is set by the tests alone (fixtures/run-tests.js, fixtures/helpers.js),
// which refresh that file every 10 s: once it is gone or has not been refreshed for 60 s, the tests
// are over, even killed (Ctrl-C, kill -9), and no loop they started may outlive them.
function testRunOver() {
  const file = process.env.RELAYLEAD_TEST_RUN_FILE;
  if (!file) return false;
  try {
    return Date.now() - fs.statSync(file).mtimeMs > TEST_RUN_STALE_MS;
  } catch {
    return true;
  }
}

// Removes the loop file only while it names this loop: another loop may have written its own.
function removeOwnLoopFile(token) {
  if (isOurs(readLoopFile(), token)) removeFile(loopFile());
}

// Whether the loop must end: the loop file names another loop (two loops started at once: the last
// one written wins), the package has changed version since the loop wrote its file (the next launch
// starts the new one), or watcher-loop.stop is there (it is left for the user's next start).
// A start removes the stop file, then looks for the loop file; on a stop, the loop removes its file,
// then reads the stop file again. So a start that comes as the loop reads its stop either finds the
// loop gone and starts another one, or is seen here: the loop writes its file again (`write`) and
// goes on. A stop holds until the next start, even during the loop's last pass.
function loopMustEnd(token, info, write) {
  if (testRunOver()) return true;
  // The home has been deleted (uninstall --purge): writing its file again would bring it back.
  if (!fs.existsSync(home())) return true;
  const loop = readLoopFile();
  if (loop && !isOurs(loop, token)) return true;
  if ((loop || info).version !== packageVersion()) return true;
  if (!fs.existsSync(loopStopFile())) return false;
  removeOwnLoopFile(token);
  if (fs.existsSync(loopStopFile())) return true;
  write();
  return false;
}

// `relaylead watcher loop`: a full pass, then a wait of everySeconds, again and again. Its file,
// watcher-loop.json, is written at its start, after each pass, and every 30 s by a timer of its own,
// so a long pass does not make it look gone. After a pass that found no mission to watch, the file is
// removed before the missions are counted again: a launch that came meanwhile either sees the loop
// gone and starts another one, or has written its mission.json before the count. On its way out,
// the loop removes its file, if it is still its own. An error that ends it is written to watcher.log.
async function loop() {
  const token = { pid: process.pid, startedAt: new Date().toISOString() };
  const info = { ...token, version: packageVersion(), beatAt: null, lastPassAt: null, everySeconds: watcherSettings().everySeconds };
  const write = () => {
    info.beatAt = new Date().toISOString();
    writeJson(loopFile(), info);
  };
  write();
  const beat = setInterval(() => {
    try {
      const current = readLoopFile();
      if (fs.existsSync(home()) && (!current || isOurs(current, token))) write();
    } catch {
      // the next beat writes it
    }
  }, LOOP_BEAT_MS);
  try {
    for (;;) {
      let result = null;
      try {
        result = await module.exports.runPass();
      } catch (err) {
        watchLog(null, 'error', `pass: ${err.message}`);
      }
      if (loopMustEnd(token, info, write)) return;
      info.lastPassAt = new Date().toISOString();
      write();
      if (result && result.outcome === 'done' && result.missions === 0) {
        removeOwnLoopFile(token);
        if (missionsToWatch() === 0 || loopMustEnd(token, info, write)) return;
        write();
      }
      for (let step = 0; step < info.everySeconds; step++) {
        await sleep(LOOP_STEP_MS);
        if (loopMustEnd(token, info, write)) return;
      }
    }
  } catch (err) {
    watchLog(null, 'error', `loop: ${err.message}`);
    throw err;
  } finally {
    clearInterval(beat);
    removeOwnLoopFile(token);
  }
}

// {running, since, lastPassAt}: running while the loop file has a beat less than 90 s old.
function watcherRunning() {
  const loop = readLoopFile();
  const beatAt = loop ? Date.parse(loop.beatAt) : NaN;
  if (!(Date.now() - beatAt < LOOP_RUNNING_MS)) return { running: false, since: null, lastPassAt: null };
  return { running: true, since: loop.startedAt, lastPassAt: loop.lastPassAt || null };
}

// Starts the loop: 'started' once its file has come (5 s at most), 'already' while one runs,
// 'nothing' when no mission is to be watched. A start first removes watcher-loop.stop, the user's
// stop: a loop still running then goes on, one that has read it already has removed its file, and
// another is started (loopMustEnd). With unlessStopped (the targeted passes), that stop is kept and
// nothing is started: 'stopped-by-user'.
async function startWatcher({ unlessStopped = false } = {}) {
  if (unlessStopped && fs.existsSync(loopStopFile())) return 'stopped-by-user';
  // Not removeFile: a stop that cannot be lifted must not go unsaid.
  withWindowsRetry(() => fs.rmSync(loopStopFile(), { force: true }));
  if (watcherRunning().running) return 'already';
  if (missionsToWatch() === 0) return 'nothing';
  await spawnDetached(['watcher', 'loop']);
  const giveUpAt = Date.now() + START_WAIT_MS;
  while (!watcherRunning().running) {
    if (Date.now() >= giveUpAt) throw codedError('watcher-not-started', { seconds: START_WAIT_MS / 1000 });
    await sleep(50);
  }
  return 'started';
}

// Asks the loop to stop with watcher-loop.stop, which stays until the next start: 'stopped' once the
// loop has removed its file (within waitMs, 10 s by default), 'requested' when it is still in a long
// pass (it ends at the end of that pass), 'not-running' when no loop runs.
async function stopWatcher({ waitMs = STOP_WAIT_MS } = {}) {
  writeText(loopStopFile(), `${new Date().toISOString()}\n`);
  if (!watcherRunning().running) return 'not-running';
  const giveUpAt = Date.now() + waitMs;
  while (fs.existsSync(loopFile())) {
    if (Date.now() >= giveUpAt) return 'requested';
    await sleep(100);
  }
  return 'stopped';
}

module.exports = { observe, act, tendMission, tendMergeOf, startQueuedTasks, runPass, stopPresent, loop, watcherRunning, startWatcher, stopWatcher };
