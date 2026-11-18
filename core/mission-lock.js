// The mission lock: one start, delivery, end or stop at a time per mission (missions/<name>/start.lock).
const fs = require('node:fs');
const path = require('node:path');
const { missionDir } = require('./paths');
const { codedError } = require('./messages');
const { isAlive } = require('./sessions');
const { gitTimeoutMs } = require('./run-file');
const { sleep } = require('./timing');

// Long enough for a slow agent launch held by another start. Read at each call.
const lockWaitMs = () => Number(process.env.RELAYLEAD_START_LOCK_WAIT_MS) || 60 * 1000;
// An empty or partly written lock file this old was left by a holder that crashed (also used for
// the folder lock of missions.js).
const EMPTY_LOCK_STALE_MS = 10 * 1000;
// A live holder this old is stuck: a delivery runs a few git commands, each stopped after
// gitTimeoutMs(), so even a slow one ends well before.
const startLockStuckMs = () => Math.max(15 * 60 * 1000, 3 * gitTimeoutMs());

function now() {
  return new Date().toISOString();
}

// Creating the file with 'wx' fails if it exists, so only one caller holds it. On Windows, a lock
// file being deleted cannot be created again for a moment (EPERM): it counts as still held.
// The file says who holds it, so a lock that is never released shows which command is stuck.
function tryCreateLock(file, command) {
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, command, since: now() }), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST' || (process.platform === 'win32' && err.code === 'EPERM')) return false;
    throw err;
  }
}

// The holder of a lock: {pid, command, since, modifiedAt}, pid 0 while its holder is still writing
// the file; null once the lock is gone. A lock written by an older relaylead holds only the pid.
function readLock(file) {
  let text;
  let modifiedAt;
  try {
    text = fs.readFileSync(file, 'utf8');
    modifiedAt = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  let holder = {};
  try {
    holder = JSON.parse(text);
  } catch {
    // empty or partly written
  }
  if (typeof holder === 'number') holder = { pid: holder };
  if (!holder || typeof holder !== 'object') holder = {};
  return {
    pid: Number(holder.pid) || 0,
    command: holder.command || '?',
    since: holder.since || new Date(modifiedAt).toISOString(),
    modifiedAt,
  };
}

// Stale: its holder process is dead, or no holder could be read from it for 10 s (a holder that
// crashed between creating the file and writing its pid). A lock that is gone is not stale.
function isStaleLock(file) {
  const lock = readLock(file);
  if (!lock) return false;
  if (lock.pid) return !isAlive(lock.pid);
  return Date.now() - lock.modifiedAt > EMPTY_LOCK_STALE_MS;
}

// Never throws: on Windows, a file another process is reading cannot always be removed at once.
// A lock left behind this way is taken over once its holder process has ended.
async function removeQuietly(file) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      fs.rmSync(file, { force: true });
      return true;
    } catch {
      await sleep(20 * attempt);
    }
  }
  return false;
}

// Only the holder of the .takeover file may delete a stale lock, after checking again that it is
// stale. Otherwise two takers could both delete it, the second one deleting the lock the first
// one has just created. `isStale` tells whether the lock is stale (the folder lock of missions.js
// has its own rule). Returns true once the stale lock is deleted.
async function takeOverStaleLock(file, isStale = isStaleLock) {
  const guard = file + '.takeover';
  if (!tryCreateLock(guard, 'takeover')) {
    if (isStaleLock(guard)) await removeQuietly(guard);
    return false;
  }
  try {
    return isStale(file) && (await removeQuietly(file));
  } finally {
    await removeQuietly(guard);
  }
}

// One start, delivery, end or stop at a time per mission: the lead may start tasks in parallel, and
// each start must see the sessions and task records written by the previous one. Deliveries take it
// too, so two git commands never change the same repository at the same time. The end of a mission
// and `relaylead stop` take it for their whole work, so a removal or a new launch cannot cross them. `command` names the holder
// ("task start a") in the lock file and in the errors of those who wait for it.
// A waiter gives up after a minute, even when it cannot read who holds it; at once if the live
// holder has held it for too long.
async function withMissionLock(name, command, action) {
  if (!fs.existsSync(missionDir(name))) throw codedError('mission-unknown', { mission: name });
  const file = path.join(missionDir(name), 'start.lock');
  const giveUpAt = Date.now() + lockWaitMs();
  try {
    while (!tryCreateLock(file, command)) {
      if (isStaleLock(file) && (await takeOverStaleLock(file))) continue;
      const lock = readLock(file);
      const known = lock && lock.pid;
      const holder = known
        ? { mission: name, command: lock.command, pid: lock.pid, since: lock.since }
        : { mission: name, command: '?', pid: '?', since: '?' };
      if (known && Date.now() - Date.parse(lock.since) > startLockStuckMs()) throw codedError('start-stuck', holder);
      if (Date.now() > giveUpAt) throw codedError('start-busy', holder);
      await sleep(50);
    }
  } catch (err) {
    // The mission folder was removed while waiting (relaylead remove).
    if (err.code === 'ENOENT') throw codedError('mission-unknown', { mission: name });
    throw err;
  }
  try {
    return await action();
  } finally {
    await removeQuietly(file);
  }
}

module.exports = { withMissionLock, takeOverStaleLock, EMPTY_LOCK_STALE_MS };
