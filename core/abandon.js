// An abandoned mission: it waits for the user, and nothing has moved for abandonDays days. A question
// is open, and nothing that tells progress has changed since: its state, tasks, questions, the
// messages told to it, its decisions and journal (PROGRESS). The readings of the sessions (heartbeats,
// context), the snapshot of `relaylead wait` and watch.json are left out: a lead that only waits
// writes them at each command. The watcher reports it once per silence (core/watcher-rules.js, rule 31), `relaylead
// list` and `relaylead doctor` show it. Nothing is ever stopped or removed for it.
const fs = require('node:fs');
const path = require('node:path');
const { missionDir } = require('./paths');
const { readJson } = require('./store');
const { DEFAULTS } = require('./config');
const { listQuestions } = require('./questions');

const DAY_MS = 24 * 60 * 60 * 1000;
// What tells that a mission moves: files and folders of the mission folder.
const PROGRESS = ['state.json', 'mission.json', 'merge.json', 'decisions.md', 'journal.log', 'tasks', 'questions', 'told'];

// The days of the mission's configuration (abandonDays): a number above 0, otherwise 7.
function abandonDays(config) {
  const days = config && config.abandonDays;
  return Number.isFinite(days) && days > 0 ? days : DEFAULTS.abandonDays;
}

// When a file of PROGRESS last changed, in ms; 0 when none can be read.
function lastActivity(name) {
  let latest = 0;
  const walk = (folder) => {
    let entries;
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else {
        try {
          latest = Math.max(latest, fs.statSync(file).mtimeMs);
        } catch {
          // removed meanwhile
        }
      }
    }
  };
  for (const entry of PROGRESS) {
    const file = path.join(missionDir(name), entry);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue; // not there (yet)
    }
    if (stat.isDirectory()) walk(file);
    else latest = Math.max(latest, stat.mtimeMs);
  }
  return latest;
}

// Whether a mission with `openQuestions` open questions and this last activity (ms) is abandoned at `now`.
function isSilent(config, openQuestions, lastActivityAt, now) {
  return openQuestions > 0 && lastActivityAt > 0 && now - lastActivityAt >= abandonDays(config) * DAY_MS;
}

// {days} when the mission `name` is abandoned now, otherwise null (a finished mission never is).
function abandonment(name) {
  try {
    const mission = readJson(path.join(missionDir(name), 'mission.json'), null);
    const record = readJson(path.join(missionDir(name), 'state.json'), { state: 'starting' });
    if (!mission || ['done', 'stopped'].includes(record.state)) return null;
    const open = listQuestions(name, { state: 'open' }).length;
    return isSilent(mission.config, open, lastActivity(name), Date.now()) ? { days: abandonDays(mission.config) } : null;
  } catch {
    return null; // being written: the next look tells
  }
}

module.exports = { DAY_MS, abandonDays, lastActivity, isSilent, abandonment };
