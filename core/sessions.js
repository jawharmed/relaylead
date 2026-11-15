// Registry of the sessions of a mission: one file per session, written by the core only.
const fs = require('node:fs');
const path = require('node:path');
const { missionDir } = require('./paths');
const { writeJson, readJson } = require('./store');
const { codedError } = require('./messages');

function sessionsDir(mission) {
  return path.join(missionDir(mission), 'sessions');
}

// Updating a session is fine; taking the file of another session with the same short id is not.
function recordSession(mission, session) {
  const file = path.join(sessionsDir(mission), `${session.shortId}.json`);
  const existing = readJson(file, null);
  if (existing && existing.sessionId !== session.sessionId) {
    throw codedError('session-exists', { mission, shortId: session.shortId });
  }
  writeJson(file, session);
}

function listSessions(mission) {
  let files;
  try {
    files = fs.readdirSync(sessionsDir(mission));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return files
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => readJson(path.join(sessionsDir(mission), file)));
}

// Signal 0 only checks that the process exists. EPERM: it exists but belongs to another user.
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

module.exports = { recordSession, listSessions, isAlive };
