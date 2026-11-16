// Launch, list and stop missions; one lock per folder so two missions never share a folder.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { home, missionDir, slug } = require('./paths');
const { writeJson, readJson } = require('./store');
const { loadConfig } = require('./config');
const { codedError } = require('./messages');
const { recordSession, listSessions, isAlive } = require('./sessions');
const { loadProfile, loadMethod } = require('./profiles');
const { writeJournal } = require('./guard');
const { getAdapter } = require('../adapters');
const { getDelivery } = require('../deliveries');
const { sleep } = require('./timing');

// States the lead may declare. 'stopped' is written by the core only.
const STATES = ['starting', 'working', 'waiting', 'done'];
const BIN = path.join(__dirname, '..', 'bin', 'relaylead.js');
const REAP_POLL_MS = 2000;
// How long the helper waits for the lead to end its turn after `state set done`; tests shorten it.
const reapMaxMs = () => Number(process.env.RELAYLEAD_REAP_MAX_MS) || 10 * 60 * 1000;

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

// A lock is stale when its process is gone or its mission is over.
function isStale(lock) {
  if (!isAlive(lock.pid)) return true;
  return ['done', 'stopped'].includes(readState(lock.mission));
}

// Creating the file with 'wx' fails if it exists: of two launches at the same time, only one wins.
function takeLock(realDir, mission) {
  const file = lockFile(realDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, mission }));
      fs.closeSync(fd);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    let lock;
    try {
      lock = readJson(file, null);
    } catch {
      // Empty or partial file: another launch has just created it and is writing it.
      throw codedError('dir-busy', { dir: realDir, mission: '?' });
    }
    if (lock === null) continue; // released in the meantime: try again
    if (!isStale(lock)) throw codedError('dir-busy', { dir: realDir, mission: lock.mission });
    fs.rmSync(file, { force: true });
  }
  throw codedError('dir-busy', { dir: realDir, mission: '?' });
}

// Only the mission that holds the lock removes it: a newer mission may have taken it over.
function releaseLock(realDir, mission) {
  const file = lockFile(realDir);
  let lock;
  try {
    lock = readJson(file, null);
  } catch {
    return; // being written by another launch, so not ours
  }
  if (lock && lock.mission === mission) fs.rmSync(file, { force: true });
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
  const leadProfile = loadProfile('lead', { dir: realDir });
  const method = loadMethod(config.method, { dir: realDir });

  takeLock(realDir, missionName);
  let reserved = false;
  let lead = null;
  try {
    reserveName(missionName);
    reserved = true;
    const mission = {
      name: missionName,
      dir: realDir,
      request: request || null,
      team: team || null,
      priority: priority || config.priority,
      agent: adapter.name,
      createdAt: now(),
      config,
    };
    // Before the lead starts: the integration worktree is where the lead reads the tasks.
    delivery.prepareMission(mission);
    writeJson(missionFile(missionName, 'mission.json'), mission);

    lead = await adapter.launch({
      mission: missionName,
      name: `${missionName}/lead/1`,
      role: 'lead',
      profile: leadProfile,
      prompt: leadPrompt(method, mission),
      cwd: realDir,
      env: { RELAYLEAD_MISSION: missionName, RELAYLEAD_HOME: home() },
      permissionMode: config.permissionMode,
    });
    // From now on the lock follows the lead: it becomes stale when the lead is gone.
    writeJson(lockFile(realDir), { pid: lead.pid, mission: missionName });
    writeJson(missionFile(missionName, 'lead.json'), {
      sessionId: lead.sessionId,
      shortId: lead.shortId,
      sessionName: lead.name,
      startedAt: now(),
    });
    recordSession(missionName, lead);
    return mission;
  } catch (err) {
    try {
      if (lead) await adapter.stop(lead); // no orphan session
    } catch {
      // Keep cleaning up, and report the first error: it says what went wrong.
    }
    // Retries: the stopped lead may still be finishing a write in the folder.
    if (reserved) fs.rmSync(missionDir(missionName), { recursive: true, force: true, maxRetries: 5 });
    releaseLock(realDir, missionName);
    throw err;
  }
}

// The lead's first message: the method to follow, then this mission. The lead profile's own
// instructions go with the profile (the adapter passes them as a system prompt).
function leadPrompt(method, mission) {
  return [
    method.instructions.trim(),
    '',
    '## This mission',
    '',
    `Mission: ${mission.name}`,
    `Limit: at most ${mission.config.parallel} tasks running at a time.`,
    '',
    'Request from the user:',
    mission.request || 'No request was given: carry out the tasks listed by `relaylead task list`.',
  ].join('\n');
}

function readMission(name) {
  const mission = readJson(missionFile(name, 'mission.json'), null);
  if (!mission) throw codedError('mission-unknown', { mission: name });
  return mission;
}

// 'starting' until the lead declares a state.
function readState(name) {
  return readJson(missionFile(name, 'state.json'), { state: 'starting' }).state;
}

function getState(name) {
  readMission(name);
  return readState(name);
}

async function setState(name, state, note) {
  const mission = readMission(name);
  if (!STATES.includes(state)) throw codedError('bad-state', { state, states: STATES.join(', ') });
  // A lead restarted after a stop must not erase the stop. Once done, only `done` again is taken:
  // it retries the stops of a done that failed.
  const current = readState(name);
  if (current === 'stopped') throw codedError('mission-stopped', { mission: name });
  if (current === 'done' && state !== 'done') throw codedError('mission-finished', { mission: name });
  writeJson(missionFile(name, 'state.json'), { state, note, updatedAt: now() });
  if (state === 'done') {
    // The lock is released last: until the crew is stopped, the folder is still in use.
    try {
      await endMission(mission);
    } finally {
      releaseLock(mission.dir, name);
    }
  }
}

// Once the mission is done, no session of it may keep running. The crew is stopped now. The lead
// cannot be: this very command runs inside its turn. A detached helper stops it once its turn is over.
// A stop that fails does not keep the other sessions running: its error is thrown at the end.
async function endMission(mission) {
  const adapter = getAdapter(mission.agent);
  const lead = readJson(missionFile(mission.name, 'lead.json'), {});
  let firstError = null;
  try {
    let sessions;
    try {
      sessions = await adapter.list(mission.name);
    } catch {
      sessions = listSessions(mission.name); // `claude agents` may fail for a moment: stop each recorded session
    }
    for (const session of sessions) {
      if (session.shortId === lead.shortId || session.state === 'stopped') continue;
      try {
        await adapter.stop(session);
      } catch (err) {
        firstError = firstError || err;
      }
    }
  } finally {
    await spawnReaper(mission.name);
  }
  if (firstError) throw firstError;
}

// Runs `relaylead _reap <mission>` on its own: it outlives this command and the lead's turn.
// No shell, so a path with spaces or quotes is passed as it is. Its pid is recorded in reaper.json,
// so one can check that it has ended.
async function spawnReaper(name) {
  const child = spawn(process.execPath, [BIN, '_reap', name], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  // Without an 'error' listener, a failed start would crash the whole process.
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  writeJson(missionFile(name, 'reaper.json'), { pid: child.pid, startedAt: now() });
}

// The helper: waits until the lead is no longer working (10 min at most), then stops it. A failing
// list is tried again until the deadline; then the lead is stopped anyway. Nobody watches the
// helper, so a stop that fails is written to the mission's journal.
async function reapLead(name) {
  const mission = readMission(name);
  const adapter = getAdapter(mission.agent);
  const lead = readJson(missionFile(name, 'lead.json'), {});
  const giveUpAt = Date.now() + reapMaxMs();
  while (Date.now() < giveUpAt) {
    try {
      const session = (await adapter.list(name)).find((candidate) => candidate.shortId === lead.shortId);
      if (!session || session.state === 'stopped') return;
      if (session.state !== 'working') break;
    } catch {
      // `claude agents` may fail for a moment: try again at the next turn.
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
      state: readState(mission.name),
      lead: readJson(missionFile(mission.name, 'lead.json'), null),
    });
  }
  return missions.sort((a, b) => a.name.localeCompare(b.name));
}

function writeStopped(name) {
  writeJson(missionFile(name, 'state.json'), { state: 'stopped', updatedAt: now() });
}

// Returns false when there was nothing to do. A stop that fails does not keep the other sessions
// running: its error is thrown at the end, and the stop can be run again.
async function stopMission(name) {
  const mission = readMission(name);
  const adapter = getAdapter(mission.agent);
  const state = readState(name);
  // A finished mission is left alone by an adapter that stops by pid: its recorded pids may now
  // belong to unrelated processes. One that stops by id (claude) is asked again: that retries a
  // stop that failed. A done mission stays done.
  if (['stopped', 'done'].includes(state) && !adapter.stopById) return false;
  // Written first, so a `state set` from a session being stopped is refused instead of erasing the stop.
  if (state !== 'done') writeStopped(name);
  let firstError = null;
  for (const session of listSessions(name)) {
    try {
      await adapter.stop(session);
    } catch (err) {
      firstError = firstError || err;
    }
  }
  // Written again: a `state set` that read the state just before the first write may have landed since.
  if (state !== 'done') writeStopped(name);
  if (firstError) throw firstError; // the folder stays locked: a session may still run in it
  releaseLock(mission.dir, name);
  return true;
}

module.exports = {
  createMission,
  listMissions,
  stopMission,
  readMission,
  getState,
  setState,
  reapLead,
  attachLead,
  lockFile,
};
