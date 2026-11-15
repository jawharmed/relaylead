// Delivery "files in a folder": each task writes into <dir>/out/<id>/, no git needed.
const fs = require('node:fs');
const path = require('node:path');
const { missionDir } = require('../core/paths');
const { writeJson, readJson } = require('../core/store');
const { codedError } = require('../core/messages');

function outDir(mission, task) {
  return path.join(mission.dir, 'out', task.id);
}

function prepareMission() {
  // Nothing to prepare: the output folders are made per task.
}

function prepareTask(mission, task) {
  const cwd = outDir(mission, task);
  fs.mkdirSync(cwd, { recursive: true });
  return { cwd, branch: null };
}

// The task record says it is delivered: there is no source to mark in a branch. No warnings.
function deliver(mission, task) {
  const folder = outDir(mission, task);
  if (!fs.existsSync(folder) || fs.readdirSync(folder).length === 0) {
    throw codedError('empty-output', { id: task.id, dir: folder });
  }
  const file = path.join(missionDir(mission.name), 'tasks', `${task.id}.json`);
  const record = readJson(file, { id: task.id });
  writeJson(file, { ...record, state: 'delivered', deliveredAt: new Date().toISOString() });
  return [];
}

// Nothing is left to finish once the record says delivered.
function finish() {
  return [];
}

module.exports = { prepareMission, prepareTask, deliver, finish };
