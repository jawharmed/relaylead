// Launch, list and stop missions; one lock per folder so two missions never share a folder.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { home, missionDir, slug } = require('./paths');
const { writeJson, readJson } = require('./store');
const { loadConfig } = require('./config');
const { codedError } = require('./messages');
const { recordSession, listSessions, isAlive, settleBoundMs } = require('./sessions');
const { loadProfile, loadMethod } = require('./profiles');
const { writeJournal } = require('./guard');
const { getAdapter } = require('../adapters');
const { getDelivery } = require('../deliveries');
const { sleep } = require('./timing');
const { spawnDetached } = require('./detached');
const { withMissionLock, takeOverStaleLock, EMPTY_LOCK_STALE_MS } = require('./mission-lock');
const { watchLog } = require('./watch-log');

// States the lead may declare. 'stopped' is written by the core only.
const STATES = ['starting', 'working', 'waiting', 'done'];
const REAP_POLL_MS = 2000;
// The states after which no session of the mission may run.
const FINISHED = ['done', 'stopped'];
// Past this age, the recorded pids of a mission may belong to unrelated processes.
const PIDS_TRUSTED_MS = 60 * 60 * 1000;
// How long the helper waits for the lead to end its turn after `state set done`; tests shorten it.
const reapMaxMs = () => Number(process.env.RELAYLEAD_REAP_MAX_MS) || 10 * 60 * 1000;
// How long a stop waits for the processes of the stopped sessions to end; tests shorten it.
const stopWaitMs = () => Number(process.env.RELAYLEAD_STOP_WAIT_MS) || 30 * 1000;
const STOP_POLL_MS = 250;
// Past this age, the folder lock of a launch that has not written its mission.json holds nothing.
const LAUNCH_LOCK_MAX_MS = 15 * 60 * 1000;

function now() {
  return new Date().toISOString();
}

function missionFile(name, file) {
  return path.join(missionDir(name), file);
}

// `realDir` must come from fs.realpathSync.native, so every spelling of a folder shares one lock.
function lockFile(realDir) {
  const hash = crypto.createHash('sha1').update(realDir).digest('hex').slice(0, 16);
  return path.join(home(), 'locks', `${hash}.lock`);
}

// The lock follows its mission, not the lead's pid: an agent may restart a lead under another pid.
// A lead gone for good is dealt with by `relaylead stop`.
function isStale(lock, file, realDir) {
  const mission = readJson(missionFile(lock.mission, 'mission.json'), null);
  // No mission yet: its launch is running, or crashed before writing it.
  if (!mission) return !launchHolds(lock, file);
  // The name now belongs to a mission of another folder, or to a newer mission. A lock without
  // createdAt was written by an older relaylead: it belongs to the mission it names.
  if (mission.dir !== realDir) return true;
  if (lock.createdAt && lock.createdAt !== mission.createdAt) return true;
  // Over, and every session stopped.
  const record = readStateRecord(lock.mission);
  return FINISHED.includes(record.state) && !record.stopping;
}

function busyError(realDir, name) {
  const record = name === '?' ? { state: 'starting' } : readStateRecord(name);
  return codedError('dir-busy', { dir: realDir, mission: name, state: shownState(record) });
}

// Milliseconds since the file was last written; Infinity once it is gone.
function ageOf(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return Infinity;
  }
}

// The folder lock: {state: 'gone'}, {state: 'stale'}, or {state: 'held', mission} where mission is
// '?' while another launch is writing it.
function readFolderLock(file, realDir) {
  let lock;
  try {
    lock = readJson(file, null);
  } catch {
    lock = undefined;
  }
  if (lock === null) return { state: 'gone' };
  if (!lock || typeof lock.mission !== 'string' || !/^[a-z0-9-]+$/.test(lock.mission)) {
    // Empty or partial file: another launch has just created it and is writing it, unless it is old.
    return ageOf(file) <= EMPTY_LOCK_STALE_MS ? { state: 'held', mission: '?' } : { state: 'stale' };
  }
  return isStale(lock, file, realDir) ? { state: 'stale' } : { state: 'held', mission: lock.mission };
}

// Whether the launch that wrote this folder lock may still be running, before its mission.json: its
// process lives and the lock is less than 15 min old. A launch takes a few minutes at most; past
// that, its pid may belong to an unrelated process (Windows soon gives it to another one, #71).
function launchHolds(lock, file) {
  return isAlive(lock.pid) && ageOf(file) < LAUNCH_LOCK_MAX_MS;
}

// The check that takeOverStaleLock runs under its guard: a lock that is gone is not stale, so a
// lock created right after the check is never deleted.
function isStaleFolderLock(realDir) {
  return readFolderLock(lockFile(realDir), realDir).state === 'stale';
}

// Creating the file with 'wx' fails if it exists: of two launches at the same time, only one wins.
// On Windows, a lock file being deleted cannot be created again for a moment (EPERM): it counts as
// still there, and is reported as is if it lasts. A stale lock is deleted under the takeover guard
// of mission-lock.js, so two launches that see the same stale lock never both delete it: the second
// one would delete the new lock of the first one. A takeover that does not delete the lock (guard
// held by another launch, stale guard removed, lock still being deleted) waits a little before the
// next attempt. The last attempt only tries 'wx': a takeover there would leave the folder free but
// report it busy.
async function takeLock(realDir, mission) {
  const file = lockFile(realDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let refused = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, mission: mission.name, createdAt: mission.createdAt }));
      fs.closeSync(fd);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST' && !(process.platform === 'win32' && err.code === 'EPERM')) throw err;
      refused = err.code === 'EPERM' ? err : null;
    }
    const lock = readFolderLock(file, realDir);
    if (lock.state === 'held') throw busyError(realDir, lock.mission);
    if (attempt === 5) break; // the last attempt only tries 'wx'
    if (lock.state === 'stale' && (await takeOverStaleLock(file, () => isStaleFolderLock(realDir)))) continue;
    await sleep(20 * attempt);
  }
  throw refused || busyError(realDir, '?');
}

// Only the mission that holds the lock removes it: a newer mission, even of the same name, may have
// taken it over. The removal goes under the takeover guard, after reading again that the lock is
// ours: a launch that has just taken the lock over (our mission is over, so our lock is stale) holds
// the guard, and its new lock must stay. While the guard is held, nothing is removed: the lock of a
// finished mission is taken over by the next launch, and the lock of a launch that failed once its
// process has ended. A second try follows the first one that fails: a stale guard, left by a taker
// that died, is only removed by the first one, and the lock must not outlive its mission.
async function releaseLock(realDir, mission) {
  const file = lockFile(realDir);
  const ours = () => {
    let lock;
    try {
      lock = readJson(file, null);
    } catch {
      return false; // being written by another launch, so not ours
    }
    if (!lock || lock.mission !== mission.name) return false;
    return !lock.createdAt || lock.createdAt === mission.createdAt;
  };
  for (let attempt = 1; attempt <= 2 && ours(); attempt++) {
    if (await takeOverStaleLock(file, ours)) return;
  }
}

// mkdir without `recursive` fails if the folder exists: two launches cannot take the same name.
function reserveName(name) {
  fs.mkdirSync(path.join(home(), 'missions'), { recursive: true });
  try {
    fs.mkdirSync(missionDir(name));
  } catch (err) {
    if (err.code === 'EEXIST') throw codedError('mission-exists', { mission: name });
    throw err;
  }
}

async function createMission({ name, dir, request, team, priority, agent, params }) {
  // The native version also gives the real letter case (macOS, Windows): CaseProj and caseproj are one folder.
  const realDir = fs.realpathSync.native(dir);
  const missionName = slug(name || path.basename(realDir));
  const config = loadConfig({ dir: realDir, params });
  const adapter = getAdapter(agent || config.agent);
  const delivery = getDelivery(config.delivery.type);
  // Read before anything is created: an unknown profile or method leaves nothing behind.
  loadProfile('lead', { dir: realDir });
  loadMethod(config.method, { dir: realDir });
  const mission = {
    name: missionName,
    dir: realDir,
    request: request || null,
    team: team || null,
    priority: priority || config.priority,
    agent: adapter.name,
    createdAt: now(), // also in the folder lock: it tells this mission from a later one of the same name
    config,
  };

  await takeLock(realDir, mission);
  let reserved = false;
  try {
    reserveName(missionName);
    reserved = true;
    // Before the lead starts: the integration worktree is where the lead reads the tasks.
    delivery.prepareMission(mission);
    writeJson(missionFile(missionName, 'mission.json'), mission);

    await launchLead(mission);
    return mission;
  } catch (err) {
    // A lead launched, then failed, was stopped by launchLead. Retries: it may still be finishing a
    // write in the folder.
    if (reserved) fs.rmSync(missionDir(missionName), { recursive: true, force: true, maxRetries: 5 });
    await releaseLock(realDir, mission);
    throw err;
  }
}

// The number of the next lead: past every lead of the registry and past the last one reserved, even
// by a launch that failed or crashed before recording its session. A name is never given twice.
function nextLeadNumber(name) {
  const named = new RegExp(`^${name}/lead/(\\d+)$`);
  const numbers = listSessions(name).map((session) => Number((named.exec(session.name) || [])[1]) || 0);
  const reserved = readJson(missionFile(name, 'lead-launch.json'), {});
  return Math.max(0, ...numbers, Number(reserved.n) || 0) + 1;
}

// Launches a lead and makes it the current one (lead.json). The caller holds the mission lock (the
// folder lock at the first launch). Its name is reserved in lead-launch.json before the launch, so
// the new lead is the current one from its first command on: claude's launch returns only once its
// first turn has started. A launch that throws is marked failed there, and a session it could not
// stop (err.orphan) goes to the watcher's log. A failure once launched stops the session it started.
// `section` (## Restart, ## Handover) comes before the mission in the lead's first message.
async function launchLead(mission, { section } = {}) {
  const name = mission.name;
  const adapter = getAdapter(mission.agent);
  const n = nextLeadNumber(name);
  const reservation = { n, name: `${name}/lead/${n}`, at: now() };
  writeJson(missionFile(name, 'lead-launch.json'), reservation);
  const failed = () => writeJson(missionFile(name, 'lead-launch.json'), { ...reservation, failed: true });
  let lead;
  try {
    lead = await adapter.launch({
      mission: name,
      name: reservation.name,
      role: 'lead',
      profile: loadProfile('lead', { dir: mission.dir }),
      prompt: leadPrompt(loadMethod(mission.config.method, { dir: mission.dir }), mission, section),
      cwd: mission.dir,
      env: { RELAYLEAD_MISSION: name, RELAYLEAD_HOME: home(), RELAYLEAD_ROLE: 'lead', RELAYLEAD_SESSION: reservation.name },
      permissionMode: mission.config.permissionMode,
    });
  } catch (err) {
    failed();
    if (err.orphan) watchLog(name, 'orphan-session', err.orphan);
    throw err;
  }
  try {
    writeJson(missionFile(name, 'lead.json'), {
      sessionId: lead.sessionId,
      shortId: lead.shortId,
      sessionName: lead.name,
      startedAt: now(),
    });
    recordSession(name, lead);
  } catch (err) {
    try {
      await adapter.stop(lead); // no orphan session
    } catch {
      // Report the first error: it says what went wrong.
    }
    failed();
    throw err;
  }
  return lead;
}

// The lead's first message: the method to follow, then this mission. The lead profile's own
// instructions go with the profile (the adapter passes them as a system prompt). A relaunched lead
// gets `section` before the mission.
function leadPrompt(method, mission, section) {
  return [
    method.instructions.trim(),
    '',
    ...(section ? [section.trim(), ''] : []),
    '## This mission',
    '',
    `Mission: ${mission.name}`,
    `Limit: at most ${mission.config.parallel} tasks running at a time.`,
    '',
    'Request from the user:',
    mission.request || 'No request was given: carry out the tasks listed by `relaylead task list`.',
  ].join('\n');
}

// Null when the session running a command may drive the mission; otherwise the not-current-lead
// error. Only a lead is checked (RELAYLEAD_ROLE, set at launch; a lead launched before it was set is
// not checked). The current lead is the one lead.json names, or the one whose launch is running:
// reserved in lead-launch.json, not failed, after the lead of lead.json started (or before any).
// claude's launch returns only once the first turn of the new lead has started, and that turn already
// runs commands.
function currentLeadError(name, env) {
  if (!env || env.RELAYLEAD_ROLE !== 'lead') return null;
  if (!fs.existsSync(missionFile(name, 'mission.json'))) return null; // the command says mission-unknown
  const session = env.RELAYLEAD_SESSION;
  const lead = readJson(missionFile(name, 'lead.json'), null);
  if (lead && session === lead.sessionName) return null;
  const launch = readJson(missionFile(name, 'lead-launch.json'), null);
  const launching = launch && !launch.failed && (!lead || Date.parse(launch.at) > Date.parse(lead.startedAt));
  if (launching && session === launch.name) return null;
  return codedError('not-current-lead', { session, mission: name, current: lead ? lead.sessionName : '-' });
}

// Launches a session unless the mission is over, and stops it if a stop came during the launch.
// `launch` records the session; `stop(session)` stops it. A stop is written before its sessions are
// stopped, so a session recorded before this second read is stopped by the stop, and one recorded
// after it is stopped here.
async function launchWhileOpen(name, launch, stop) {
  const before = readStateRecord(name);
  if (before.state === 'done') throw codedError('mission-done', { mission: name });
  if (before.state === 'stopped' || before.stopping) throw codedError('mission-stopped', { mission: name });
  const session = await launch();
  const after = readStateRecord(name);
  if (after.state === 'stopped' || after.stopping) {
    await stop(session);
    throw codedError(after.state === 'done' ? 'mission-done' : 'mission-stopped', { mission: name });
  }
  return session;
}

function readMission(name) {
  const mission = readJson(missionFile(name, 'mission.json'), null);
  if (!mission) throw codedError('mission-unknown', { mission: name });
  return mission;
}

// {state, note, stopping, updatedAt}: state.json, or 'starting' until the lead declares a state.
function readStateRecord(name) {
  return readJson(missionFile(name, 'state.json'), { state: 'starting' });
}

function readState(name) {
  return readStateRecord(name).state;
}

// The state as the user sees it: "stopped, stopping" while its sessions are still being stopped.
function shownState(record) {
  return record.stopping ? `${record.state}, stopping` : record.state;
}

// `stopping: true` keeps the folder locked while the sessions of a stopped or done mission are being
// stopped. Only the core writes it.
function writeState(name, { state, note, stopping }) {
  const record = { state, note, updatedAt: now() };
  if (stopping) record.stopping = true;
  writeJson(missionFile(name, 'state.json'), record);
}

function getState(name) {
  readMission(name);
  return readState(name);
}

// For `done`, returns 'stopped' once the sessions are stopped, or 'skipped' when a done replayed
// was too old to stop its sessions again; null otherwise (any other state, or nothing left to stop).
async function setState(name, state, note) {
  const mission = readMission(name);
  if (!STATES.includes(state)) throw codedError('bad-state', { state, states: STATES.join(', ') });
  // A lead restarted after a stop must not erase the stop. Once done, only `done` again is taken:
  // it retries the stops of a done that failed.
  const current = readStateRecord(name);
  if (current.state === 'stopped') throw codedError('mission-stopped', { mission: name });
  if (current.state === 'done' && state !== 'done') throw codedError('mission-finished', { mission: name });
  if (state !== 'done') {
    writeState(name, { state, note });
    return null;
  }
  // A replay keeps the state as it is, with its date: that date tells how old the pids are.
  const replay = current.state === 'done';
  if (replay && !needsStop(mission, current)) return null;
  if (!replay) writeState(name, { state: 'done', note, stopping: true });
  const record = replay ? current : { state: 'done', note };
  // The mission lock keeps a removal or a new launch from crossing the end.
  const { outcome } = await withMissionLock(name, 'state set done', () =>
    stopAndFree(mission, record, () => endMission(mission)),
  );
  return outcome;
}

// Once the mission is done, no session of it may keep running. The crew is stopped now. The lead
// cannot be: this very command runs inside its turn. A detached helper stops it once its turn is over.
// Returns what stopSessionsAndWait returns.
async function endMission(mission) {
  const adapter = getAdapter(mission.agent);
  const lead = readJson(missionFile(mission.name, 'lead.json'), {});
  try {
    let sessions;
    try {
      sessions = await adapter.list(mission.name);
    } catch {
      sessions = listSessions(mission.name); // `claude agents` may fail for a moment: stop each recorded session
    }
    const crew = sessions.filter((session) => session.shortId !== lead.shortId && session.state !== 'stopped');
    return await stopSessionsAndWait(mission, crew);
  } finally {
    await spawnReaper(mission.name, mission.createdAt);
  }
}

// Stops each session, then waits for each stopped one to end. A stop that fails does not keep the
// other sessions running. Returns {failed, alive, error}: the sessions whose stop failed, those still
// running after the wait, and the first stop error.
async function stopSessionsAndWait(mission, sessions) {
  const adapter = getAdapter(mission.agent);
  // Taken before the stops: the adapter knows the current process of a session, which may have been
  // restarted since it was recorded.
  let listed = null;
  try {
    listed = await adapter.list(mission.name);
  } catch {
    // `claude agents` may fail for a moment: the registry pids will do
  }
  const registry = listSessions(mission.name);
  const failed = [];
  const stopped = [];
  let error = null;
  for (const session of sessions) {
    try {
      await adapter.stop(session);
      stopped.push({ session, ...pidToWaitFor(listed, registry, session), unlistedAt: null });
    } catch (err) {
      failed.push(session);
      error = error || err;
    }
  }
  const giveUpAt = Date.now() + stopWaitMs();
  let alive = await stillRunning(adapter, mission, stopped, giveUpAt);
  while (alive.length > 0 && Date.now() < giveUpAt) {
    await sleep(STOP_POLL_MS);
    alive = await stillRunning(adapter, mission, alive, giveUpAt);
  }
  return { failed, alive: alive.map((entry) => entry.session), error };
}

// The stopped sessions that have not ended yet, read again from the adapter. A session has ended once
// the adapter lists no process for it (first step) and the pid read before its stop is dead (second
// step, measured fact 1). Before `giveUpAt`, the second step lasts at most the entry's `settleMs`,
// after which the session counts as ended. A list that fails leaves this round to the pid alone.
async function stillRunning(adapter, mission, entries, giveUpAt) {
  let rows = null;
  try {
    rows = await adapter.list(mission.name);
  } catch {
    // `claude agents` may fail for a moment: the next round reads it again
  }
  const now = Date.now();
  return entries.filter((entry) => {
    if (!rows) return isAlive(entry.pid);
    if (hasProcess(rows, entry.session)) {
      entry.unlistedAt = null;
      return true;
    }
    if (entry.unlistedAt === null) entry.unlistedAt = now;
    if (!isAlive(entry.pid)) return false;
    return now >= giveUpAt || now - entry.unlistedAt < entry.settleMs;
  });
}

// Whether the adapter lists a process for the session. No row, or a row without a pid: the agent
// knows no process, though the last one may still be ending.
function hasProcess(rows, session) {
  return rows.some((row) => row.shortId === session.shortId && Boolean(row.pid));
}

// {pid, settleMs}: the pid read before the stop, to wait for once the session is stopped, and how
// long the second step may last (settleBoundMs). The pid the adapter lists for the session. A session
// it does not list has no process: null. A row without a pid (a stop run again, or within the 1.5 s
// when the row has lost its pid, measured fact 1): the registry pid, as a fallback that may by now
// belong to an unrelated process, so with the short bound. When the list has failed: the registry
// pid, with the whole wait, as before.
function pidToWaitFor(listed, registry, session) {
  const recorded = (registry.find((candidate) => candidate.shortId === session.shortId) || session).pid;
  if (!listed) return { pid: recorded, settleMs: settleBoundMs(stopWaitMs()) };
  const row = listed.find((candidate) => candidate.shortId === session.shortId);
  if (!row) return { pid: null, settleMs: 0 };
  if (row.pid) return { pid: row.pid, settleMs: settleBoundMs(stopWaitMs()) };
  return { pid: recorded, settleMs: settleBoundMs(stopWaitMs(), { fallback: true }) };
}

// The folders of these sessions. An adapter row may have no folder: the registry has it.
function sessionDirs(mission, sessions) {
  const registry = listSessions(mission.name);
  return sessions
    .map((session) => session.cwd || (registry.find((recorded) => recorded.shortId === session.shortId) || {}).cwd)
    .filter(Boolean);
}

// Removes the task worktrees the delivery can remove, except those where a session may still run.
// Never throws: each warning is also written to the mission's journal, which outlives the command.
function cleanMission(mission, keepDirs) {
  const warnings = getDelivery(mission.config.delivery.type).cleanMission(mission, { keepDirs });
  for (const warning of warnings) writeJournal(mission.name, 'relaylead', warning.message);
  return warnings;
}

// Runs `relaylead _reap <mission> <createdAt>` on its own (spawnDetached): it outlives this command
// and the lead's turn. The createdAt ties it to this mission: once the mission is removed and launched
// again under the same name, the helper leaves the new one alone. Its pid is recorded in reaper.json;
// the helper itself writes reaper-ended.json as it exits (markReaperEnded), so one can check that it
// has ended without reading its pid, which Windows soon gives to another process.
async function spawnReaper(name, createdAt) {
  const pid = await spawnDetached(createdAt ? ['_reap', name, createdAt] : ['_reap', name]);
  writeJson(missionFile(name, 'reaper.json'), { pid, startedAt: now() });
}

// The helper: waits until the lead has ended its last turn (10 min at most), then stops it. The turn
// has ended when the lead is no longer working, or when the adapter says it is idle, with a process,
// on two reads in a row: claude may leave a lead "working" and idle after its turn, and a single idle
// read may be passing (spike, point 2g). A read without a pid does not count: after a relaunch by the
// daemon, claude shows the lead working without a process for a few seconds (spike, point 4), and a
// stop then could miss the relaunched lead. An unknown state counts as working, so a future state
// that is idle with a process also stops the lead after two reads: acceptable once the lead is done.
// An adapter that gives no `idle` is judged on its state alone. A failing list is tried again until
// the deadline and breaks a run of idle reads; at the deadline the lead is stopped anyway. Nobody
// watches the helper, so a stop that fails is written to the mission's journal. A helper of an older
// mission of the same name returns at once.
async function reapLead(name, createdAt) {
  if (!isMissionOf(name, createdAt)) return;
  const mission = readMission(name);
  const adapter = getAdapter(mission.agent);
  const lead = readJson(missionFile(name, 'lead.json'), {});
  const giveUpAt = Date.now() + reapMaxMs();
  let idleReads = 0;
  while (Date.now() < giveUpAt) {
    try {
      const session = (await adapter.list(name)).find((candidate) => candidate.shortId === lead.shortId);
      if (!session || session.state === 'stopped') return;
      if (session.state !== 'working') break;
      idleReads = session.idle === true && session.pid ? idleReads + 1 : 0;
      if (idleReads === 2) break;
    } catch {
      // `claude agents` may fail for a moment: try again at the next turn.
      idleReads = 0;
    }
    await sleep(REAP_POLL_MS);
  }
  // The registry record: it has the pid and short id the adapter needs, even when the list failed.
  const session = listSessions(name).find((candidate) => candidate.shortId === lead.shortId);
  if (!session) return;
  try {
    await adapter.stop(session);
  } catch (err) {
    writeJournal(name, 'reaper', `could not stop the lead ${lead.shortId}: ${err.message}`);
  }
}

// The helper's last act (`relaylead _reap`), however reapLead ended: reaper-ended.json, with its pid
// and the time. Written by the helper alone; reaper.json, written by `state set done`, only says it
// was started. Never into a mission folder removed meanwhile: a folder written again would keep the
// name taken; nor into a newer mission of the same name. Never throws: the helper is exiting, so every
// error is ignored, not only a missing folder.
function markReaperEnded(name, createdAt) {
  try {
    if (!isMissionOf(name, createdAt)) return;
    writeJson(missionFile(name, 'reaper-ended.json'), { pid: process.pid, endedAt: now() }, { createDir: false });
  } catch {
    // The mission folder is gone (nobody will read the file), or the write failed: the helper ends anyway.
  }
}

// Whether mission.json is that of the mission created at `createdAt`. A helper started by an older
// relaylead gives no createdAt: it acts on the mission of that name, as it did then.
function isMissionOf(name, createdAt) {
  if (!createdAt) return true;
  const mission = readJson(missionFile(name, 'mission.json'), null);
  return Boolean(mission) && mission.createdAt === createdAt;
}

// `relaylead show`: the user's terminal joins the lead's session. Resolves with its exit code.
async function attachLead(name) {
  const mission = readMission(name);
  const lead = readJson(missionFile(name, 'lead.json'), null);
  const session = lead && listSessions(name).find((candidate) => candidate.shortId === lead.shortId);
  if (!session) throw codedError('no-lead', { mission: name });
  return getAdapter(mission.agent).attach(session);
}

function listMissions() {
  let entries;
  try {
    entries = fs.readdirSync(path.join(home(), 'missions'), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const missions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const mission = readJson(missionFile(entry.name, 'mission.json'), null);
    if (!mission) continue; // still being created
    missions.push({
      name: mission.name,
      dir: mission.dir,
      state: shownState(readStateRecord(mission.name)),
      lead: readJson(missionFile(mission.name, 'lead.json'), null),
    });
  }
  return missions.sort((a, b) => a.name.localeCompare(b.name));
}

// Whether the sessions of a mission must be stopped (again). A mission still stopping always is:
// its stop has not finished, and its pids are recent. A finished one is left alone by an adapter
// that stops by pid, as its recorded pids may now belong to unrelated processes; one that stops by
// id (claude) is asked again, which retries a stop that failed.
function needsStop(mission, record) {
  if (!FINISHED.includes(record.state) || record.stopping) return true;
  return Boolean(getAdapter(mission.agent).stopById);
}

// Stops the sessions with `stopAll`, which returns {failed, alive, error} (stopSessionsAndWait), then
// cleans the task worktrees, except those of the sessions that may still run. Once every session is
// stopped and its process gone, the state is written again without the stopping marker, then the
// folder is freed. Otherwise both stay: the folder may still be in use, and the stop can be run
// again; the first error is thrown, with the cleanup warnings in err.warnings.
// With a marker more than an hour old, an adapter that stops by pid is not called: those pids are no
// longer safe to stop. The marker is cleared and the folder freed all the same.
// Returns {outcome: 'stopped' or 'skipped', warnings}.
async function stopAndFree(mission, record, stopAll) {
  const pidsTooOld = record.stopping && Date.now() - Date.parse(record.updatedAt) > PIDS_TRUSTED_MS;
  const skipped = pidsTooOld && !getAdapter(mission.agent).stopById;
  let failed = [];
  let alive = [];
  let error = null;
  let mayRun; // the sessions whose worktree must be kept
  if (skipped) {
    // Not stopped: a recorded pid still alive may be one of its sessions, so its worktree stays.
    mayRun = listSessions(mission.name).filter((session) => isAlive(session.pid));
  } else {
    ({ failed, alive, error } = await stopAll());
    mayRun = [...failed, ...alive];
  }
  const warnings = cleanMission(mission, sessionDirs(mission, mayRun));
  let firstError = error;
  if (!firstError && alive.length > 0) {
    firstError = codedError('session-still-alive', { mission: mission.name, shortId: alive[0].shortId });
  }
  if (firstError) {
    firstError.warnings = warnings;
    throw firstError;
  }
  writeState(mission.name, { state: record.state, note: record.note });
  await releaseLock(mission.dir, mission);
  return { outcome: skipped ? 'skipped' : 'stopped', warnings };
}

// Returns {outcome, warnings}. outcome: 'stopped' (the mission was running, or was stopped and is
// stopped again), 'already-done' (a done mission whose sessions were stopped again), 'skipped' (pids
// too old to stop again) or 'nothing' (nothing to stop). In every case the task worktrees are
// cleaned, so running stop again finishes a cleanup that failed; warnings are its Error[]. A stop
// that fails does not keep the other sessions running: its error is thrown at the end, and the stop
// can be run again. A done mission stays done.
async function stopMission(name) {
  const mission = readMission(name);
  const current = readStateRecord(name);
  if (!needsStop(mission, current)) {
    return withMissionLock(name, 'stop', () => ({ outcome: 'nothing', warnings: cleanMission(mission, []) }));
  }
  // A replay keeps the state as it is, with its date: that date tells how old the pids are.
  const replay = FINISHED.includes(current.state);
  const record = replay ? current : { state: 'stopped' };
  // Written first, so a `state set` from a session being stopped is refused instead of erasing the stop.
  if (!replay) writeState(name, { state: 'stopped', stopping: true });
  // The sessions are stopped under the mission lock, behind a start or a delivery that is running.
  // When that wait gives up, the state stays stopped and the folder stays locked: stop can be run again.
  // A stuck holder (start-stuck) is not turned into stop-pending: running stop again would fail until
  // that process is ended, and its error says so.
  try {
    const { outcome, warnings } = await withMissionLock(name, 'stop', () =>
      stopAndFree(mission, record, () => stopSessions(mission, !replay)),
    );
    return { outcome: outcome === 'stopped' && record.state === 'done' ? 'already-done' : outcome, warnings };
  } catch (err) {
    if (err.code === 'start-busy') {
      throw codedError('stop-pending', { mission: name, holder: err.vars.command });
    }
    throw err;
  }
}

// Returns what stopSessionsAndWait returns.
async function stopSessions(mission, justStopped) {
  const result = await stopSessionsAndWait(mission, listSessions(mission.name));
  // Written again: a `state set` that read the state just before the first write may have landed since.
  if (justStopped) writeState(mission.name, { state: 'stopped', stopping: true });
  return result;
}

// Whether a launch of this mission is running: a folder lock names it and still holds (launchHolds).
// The launch has reserved the mission folder but not written mission.json yet.
function launchRunning(name) {
  const locks = path.join(home(), 'locks');
  let files;
  try {
    files = fs.readdirSync(locks);
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  return files.some((file) => {
    const lockPath = path.join(locks, file);
    let lock;
    try {
      lock = readJson(lockPath, null);
    } catch {
      return false; // being written: not readable yet
    }
    return Boolean(lock && lock.mission === name && launchHolds(lock, lockPath));
  });
}

// `relaylead remove`: frees the name and the folder of a finished mission. Its sessions are stopped
// again by an adapter that stops by id, its task worktrees and branches are removed by the delivery,
// then its folder under missions/ is deleted. Returns the deleted branches ("<name> <sha>"), each
// also passed to onBranchDeleted as soon as it is deleted.
async function removeMission(name, { force = false, onBranchDeleted } = {}) {
  // The name ends up in a recursive removal: no "..", no separator.
  if (!/^[a-z0-9-]+$/.test(name)) throw codedError('usage', { usage: 'relaylead remove <mission> [--force]' });
  const folder = missionDir(name);
  if (!fs.existsSync(folder)) throw codedError('mission-unknown', { mission: name });
  // No mission.json: a removal that was interrupted, or a folder written again by a late helper. Unless
  // a launch is creating it right now.
  if (!fs.existsSync(path.join(folder, 'mission.json'))) {
    if (launchRunning(name)) throw codedError('dir-busy', { dir: folder, mission: name, state: 'starting' });
    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
    return [];
  }
  // Under the mission lock: an end of mission (`state set done`) still running is waited for.
  const deleted = await withMissionLock(name, 'remove', async () => {
    const mission = readMission(name);
    const record = readStateRecord(name);
    if (!FINISHED.includes(record.state) || record.stopping) {
      throw codedError('mission-running', { mission: name, state: shownState(record) });
    }
    // Stopping by id again is harmless, and catches a session restarted since. A stop by pid is not
    // tried: the recorded pids may belong to unrelated processes by now.
    const adapter = getAdapter(mission.agent);
    if (adapter.stopById) {
      for (const session of listSessions(name)) await adapter.stop(session);
    }
    // A project folder deleted since has no worktree or branch left to remove.
    const branches = fs.existsSync(mission.dir)
      ? getDelivery(mission.config.delivery.type).removeMission(mission, { force, onBranchDeleted })
      : [];
    await releaseLock(mission.dir, mission);
    return branches;
  });
  // Retries: on Windows, a helper that has just ended may still hold a file for a moment.
  fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
  return deleted;
}

module.exports = {
  createMission,
  launchLead,
  launchWhileOpen,
  currentLeadError,
  listMissions,
  stopMission,
  stopSessionsAndWait,
  removeMission,
  readMission,
  getState,
  setState,
  reapLead,
  markReaperEnded,
  attachLead,
  lockFile,
  releaseLock,
  isStaleFolderLock,
};
