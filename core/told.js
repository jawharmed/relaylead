// What the user tells a lead with `relaylead tell`: one file per message,
// missions/<m>/told/<nnnnnn>.json = {id, text, at}. Only `tell` writes them, each one once (an
// exclusive link, like the mailbox); they stay in the mission as its memory. The lead reads them
// through `relaylead wait`, which reports each new one (core/wait.js).
const fs = require('node:fs');
const path = require('node:path');
const { missionDir } = require('./paths');
const { writeJsonExclusive, readJson } = require('./store');
const { codedError } = require('./messages');
const { readMission, getState } = require('./missions');

function toldDir(mission) {
  return path.join(missionDir(mission), 'told');
}

function messageNames(mission) {
  try {
    return fs.readdirSync(toldDir(mission)).filter((name) => /^\d+\.json$/.test(name)).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// The messages told to a mission, oldest first.
function listTold(mission) {
  return messageNames(mission).map((name) => readJson(path.join(toldDir(mission), name)));
}

// Records a message and returns its id (m-000001, m-000002...). A mission that is over has no lead
// to read it. Two tells at once take two numbers: the one that loses the race counts on.
function tellMission(mission, text) {
  readMission(mission); // mission-unknown
  if (!String(text || '').trim()) throw codedError('bad-tell', {});
  if (['done', 'stopped'].includes(getState(mission))) throw codedError('mission-over', { mission });
  let n = messageNames(mission).length + 1;
  for (;;) {
    const id = `m-${String(n).padStart(6, '0')}`;
    const message = { id, text: String(text).trim(), at: new Date().toISOString() };
    if (writeJsonExclusive(path.join(toldDir(mission), `${String(n).padStart(6, '0')}.json`), message)) return id;
    n++;
  }
}

module.exports = { tellMission, listTold };
