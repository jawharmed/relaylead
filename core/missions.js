// Launch, list and stop missions; one lock per folder so two missions never share a folder.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { home, missionDir, slug } = require('./paths');
const { writeJson, readJson } = require('./store');
const { loadConfig } = require('./config');
const { codedError } = require('./messages');
const { recordSession, listSessions, isAlive } = require('./sessions');
const { getAdapter } = require('../adapters');
const { getDelivery } = require('../deliveries');

// States the lead may declare. 'stopped' is written by the core only.
const STATES = ['starting', 'working', 'waiting', 'done'];

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
      profile: null,
      prompt: request || '',
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

function setState(name, state, note) {
  const mission = readMission(name);
  if (!STATES.includes(state)) throw codedError('bad-state', { state, states: STATES.join(', ') });
  // A lead restarted after a stop must not erase the stop.
  if (readState(name) === 'stopped') throw codedError('mission-stopped', { mission: name });
  writeJson(missionFile(name, 'state.json'), { state, note, updatedAt: now() });
  if (state === 'done') releaseLock(mission.dir, name);
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

async function stopMission(name) {
  const mission = readMission(name);
  // A finished mission is left alone: its recorded pids may now belong to unrelated processes.
  if (['stopped', 'done'].includes(readState(name))) return;
  const adapter = getAdapter(mission.agent);
  // Written first, so a `state set` from a session being stopped is refused instead of erasing the stop.
  writeStopped(name);
  for (const session of listSessions(name)) {
    await adapter.stop(session);
  }
  // Written again: a `state set` that read the state just before the first write may have landed since.
  writeStopped(name);
  releaseLock(mission.dir, name);
}

module.exports = { createMission, listMissions, stopMission, readMission, getState, setState, lockFile };
