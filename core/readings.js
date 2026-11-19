// What the sessions measure of themselves, through their hooks and their status line: a heartbeat at
// each action and the size of their context. One file per writer: heartbeats/<shortId>.json (hook
// PostToolUse, Stop), context/<shortId>.json (the measuring status line). The thresholds are worked
// out here too, by the watcher: the hooks only take readings, and stay fast.
const fs = require('node:fs');
const path = require('node:path');
const { missionDir } = require('./paths');
const { readJson, writeJson } = require('./store');
const { DEFAULTS, deepMerge } = require('./config');

// Only the end of a transcript is read: a long session's transcript runs to many megabytes.
const TRANSCRIPT_TAIL_BYTES = 262144;
// An active session takes readings at each answer: one older than this says nothing of it any more.
const READING_STALE_MS = 30 * 60 * 1000;

// The short id of a Claude session id (its first 8 hex digits), or null.
function shortIdOf(sessionId) {
  const shortId = typeof sessionId === 'string' ? sessionId.slice(0, 8) : '';
  return /^[0-9a-f]{8}$/.test(shortId) ? shortId : null;
}

function count(value) {
  return Number.isFinite(value) ? value : 0;
}

// The context of a usage: what the model read, cached or not. Null when it read nothing: a synthetic
// answer (an API error, a rate limit) measures no context, and must not become the base.
function inputTokens(usage) {
  const total = count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens);
  return total > 0 ? total : null;
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The last TRANSCRIPT_TAIL_BYTES of a file, without the first line when it is cut.
function tailLines(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    return size > length ? lines.slice(1) : lines;
  } finally {
    fs.closeSync(fd);
  }
}

// The context of the last answer of the main thread that measures one (a helper agent's answers are
// sidechains), or null: no such answer in the end of the file, or no file.
function contextFromTranscript(file) {
  let lines;
  try {
    lines = tailLines(file);
  } catch {
    return null;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue; // a line being written, or cut
    }
    if (!isObject(entry) || entry.isSidechain === true) continue;
    if (entry.type === 'assistant' && isObject(entry.message) && isObject(entry.message.usage)) {
      const tokens = inputTokens(entry.message.usage);
      if (tokens !== null) return tokens;
    }
  }
  return null;
}

// An unreadable reading is no reading.
function readReading(file) {
  try {
    const reading = readJson(file, null);
    return isObject(reading) ? reading : null;
  } catch {
    return null;
  }
}

function readingFile(mission, folder, shortId) {
  return path.join(missionDir(mission), folder, `${shortId}.json`);
}

// Writes a reading over the previous one. A missing value keeps the previous one; the base is the
// first context ever read. Throws when the mission folder is gone, which is never made again: the
// session of a removed mission writes nothing.
function writeReading(mission, folder, shortId, fields) {
  const file = readingFile(mission, folder, shortId);
  const previous = readReading(file) || {};
  const reading = { at: new Date().toISOString() };
  for (const [key, value] of Object.entries(fields)) reading[key] = value != null ? value : previous[key] ?? null;
  reading.baseTokens = previous.baseTokens != null ? previous.baseTokens : reading.contextTokens;
  if (!fs.existsSync(path.dirname(file))) fs.mkdirSync(path.dirname(file));
  writeJson(file, reading, { createDir: false });
}

function recordHeartbeat(mission, shortId, { tool, contextTokens }) {
  writeReading(mission, 'heartbeats', shortId, { tool, contextTokens });
}

// `input` is what Claude Code gives the status line: the window from the first call, the context
// once the model has answered (current_usage is null before).
function recordStatusline(mission, shortId, input) {
  const window = isObject(input.context_window) ? input.context_window : {};
  writeReading(mission, 'context', shortId, {
    contextTokens: isObject(window.current_usage) ? inputTokens(window.current_usage) : null,
    windowTokens: Number.isFinite(window.context_window_size) ? window.context_window_size : null,
  });
}

// The readings of a session, each null when absent or unreadable. The failure comes with the
// StopFailure hook (Task 5).
function readReadings(mission, shortId) {
  return {
    heartbeat: readReading(readingFile(mission, 'heartbeats', shortId)),
    statusline: readReading(readingFile(mission, 'context', shortId)),
    failure: null,
  };
}

function hasContext(reading) {
  return Boolean(reading) && Number.isFinite(reading.contextTokens);
}

// The context of a session and its thresholds, or null when nothing is known of it. The freshest of
// the two readings wins; only the status line knows the window. A session that is not active has
// taken its last reading: an old one is still right. `now` in ms; `role` is 'lead' or 'crew'.
function contextOf(readings, { role, config, now = Date.now(), active }) {
  const settings = deepMerge(DEFAULTS.context, (config && config.context) || {});
  const { heartbeat, statusline } = readings;
  const reading = [heartbeat, statusline]
    .filter(hasContext)
    .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))[0];
  if (!reading) return null;
  // An unreadable date is as old as can be.
  if (active && !(now - Date.parse(reading.at) <= READING_STALE_MS)) return null;
  const tokens = reading.contextTokens;
  const windowTokens = statusline && Number.isFinite(statusline.windowTokens) ? statusline.windowTokens : null;
  const baseTokens = [heartbeat, statusline].map((one) => one && one.baseTokens).find(Number.isFinite) ?? tokens;
  let soft = baseTokens + (role === 'lead' ? settings.budgets.lead : settings.budgets.crew);
  if (windowTokens) soft = Math.min(soft, Math.floor((settings.capPercent * windowTokens) / 100));
  const hard = Math.floor((soft * (100 + settings.hardPercent)) / 100);
  return { tokens, windowTokens, baseTokens, at: reading.at, soft, hard };
}

module.exports = {
  READING_STALE_MS,
  shortIdOf,
  contextFromTranscript,
  recordHeartbeat,
  recordStatusline,
  readReadings,
  contextOf,
};
