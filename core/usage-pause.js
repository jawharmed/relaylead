// The pause of a mission for the usage limits of the account: missions/<mission>/usage-pause.json,
// {at, reason, resumeAt}, written and removed by the watcher alone (core/watcher.js). While it is
// there, no session of the mission is started: the watcher relaunches nothing, and `relaylead task
// start|retry` are refused.
const fs = require('node:fs');
const path = require('node:path');
const { missionDir } = require('./paths');
const { readJson, writeJson, withWindowsRetry } = require('./store');
const { codedError } = require('./messages');

function pauseFile(name) {
  return path.join(missionDir(name), 'usage-pause.json');
}

// The pause of a mission, or null when it is not paused (or the file cannot be read).
function readPause(name) {
  try {
    return readJson(pauseFile(name), null);
  } catch {
    return null;
  }
}

// `resumeAt` in ms. Never makes the mission folder: a mission removed meanwhile gets no pause.
function writePause(name, { reason, resumeAt }) {
  writeJson(pauseFile(name), { at: new Date().toISOString(), reason, resumeAt: new Date(resumeAt).toISOString() }, { createDir: false });
}

function removePause(name) {
  withWindowsRetry(() => fs.rmSync(pauseFile(name), { force: true }));
}

// A time as the user reads it, in the machine's time zone: 2026-11-21 14:05.
function localTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Throws mission-usage-paused while the mission is paused.
function refuseWhilePaused(name) {
  const pause = readPause(name);
  if (pause) throw codedError('mission-usage-paused', { mission: name, resumeAt: localTime(pause.resumeAt) });
}

module.exports = { readPause, writePause, removePause, localTime, refuseWhilePaused };
