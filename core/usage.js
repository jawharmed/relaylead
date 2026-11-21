// The usage of the account, as the measuring status line reads it (Pro and Max accounts): how much of
// the 5-hour and of the 7-day limits is used, and when each resets. One file for the machine,
// ~/.relaylead/usage.json, by agent: { claude: { at, fiveHour: { percent, resetsAt }, sevenDay } }.
// Every session writes the same values of the same account: the last one to write wins, which is
// right. Read by the watcher (watcher-rules.js, usageVerdict).
const path = require('node:path');
const { home } = require('./paths');
const { readJson, writeJson } = require('./store');
const { READING_STALE_MS } = require('./readings');

function usageFile() {
  return path.join(home(), 'usage.json');
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// One window of rate_limits ({used_percentage, resets_at in seconds since 1970}), or null when the
// status line does not give it (an account with an API key).
function windowOf(limit) {
  if (!isObject(limit) || !Number.isFinite(limit.used_percentage)) return null;
  const resetsAt = Number.isFinite(limit.resets_at) ? new Date(limit.resets_at * 1000).toISOString() : null;
  return { percent: limit.used_percentage, resetsAt };
}

// `rateLimits` is the rate_limits object Claude Code gives the status line. Nothing is written when
// neither window is there. The usage of the other agents is kept.
function recordUsage(agent, rateLimits) {
  if (!isObject(rateLimits)) return;
  const fiveHour = windowOf(rateLimits.five_hour);
  const sevenDay = windowOf(rateLimits.seven_day);
  if (!fiveHour && !sevenDay) return;
  let previous = {};
  try {
    previous = readJson(usageFile(), {});
  } catch {
    // unreadable: written again from scratch
  }
  writeJson(usageFile(), { ...previous, [agent]: { at: new Date().toISOString(), fiveHour, sevenDay } });
}

// Whether a reading of the usage was taken less than 30 min before `now` (ms). An unreadable date is
// as old as can be.
function isFresh(usage, now) {
  return isObject(usage) && now - Date.parse(usage.at) <= READING_STALE_MS;
}

// The usage of `agent`, or null when it is older than 30 min, missing or unreadable.
function readUsage(agent, now = Date.now()) {
  try {
    const usage = readJson(usageFile(), {})[agent];
    return isFresh(usage, now) ? usage : null;
  } catch {
    return null;
  }
}

module.exports = { usageFile, recordUsage, readUsage, isFresh };
