// decisions.md of a mission: one line per decision the lead took with the user, added by
// `relaylead decision`. The lead of the mission is its only writer, and only the lead reads it
// again (a fresh lead after a relaunch or a handover reads it first).
const fs = require('node:fs');
const path = require('node:path');
const { missionDir } = require('./paths');
const { codedError } = require('./messages');
const { readMission } = require('./missions');

function decisionsFile(mission) {
  return path.join(missionDir(mission), 'decisions.md');
}

function addDecision(mission, text) {
  readMission(mission); // mission-unknown
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  if (!line) throw codedError('bad-decision', {});
  fs.appendFileSync(decisionsFile(mission), `- ${new Date().toISOString()} ${line}\n`);
}

// The decisions noted so far; an empty text when there are none.
function readDecisions(mission) {
  readMission(mission); // mission-unknown
  try {
    return fs.readFileSync(decisionsFile(mission), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

module.exports = { addDecision, readDecisions, decisionsFile };
