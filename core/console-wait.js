// `relaylead wait --all`: for the console (the Claude Code conversation). Blocks until something
// happens that the user must know about, in any mission of the machine, and says which mission each
// event belongs to: a question opened, a task failed, a mission done or stopped. It does not touch
// the snapshots of the leads (wait-snapshot.json): a lead and the console never take each other's changes.
// The last view is kept in console-snapshot.json at the root of ~/.relaylead, written only here, after
// the events are given, so none is lost on the way out. Something that happens while no console
// waits is given by the next wait; a new conversation also lists everything itself (list, question list).
const path = require('node:path');
const { home } = require('./paths');
const { writeJson, readJson } = require('./store');
const { listMissions } = require('./missions');
const { listTasks } = require('./tasks');
const { listQuestions } = require('./questions');
const { readMerge } = require('./merge');
const { readPause, pausePercent } = require('./usage-pause');
const { sleep } = require('./timing');

const POLL_MS = 1000;
const FINISHED = /^(done|stopped)/;

function snapshotFile() {
  return path.join(home(), 'console-snapshot.json');
}

// What the console follows in one mission, by key: question:<id> -> open|answered, task:<id> -> its
// state and attempt, mission -> its state. Plus the events these states make now, by key.
function viewOfMission(mission, known) {
  // "done, stopping" then "done": one state, so one event.
  const view = { mission: mission.state.replace(/, stopping$/, '') };
  const events = { mission: FINISHED.test(mission.state) ? { kind: 'mission', id: mission.name, state: mission.state } : null };
  for (const question of listQuestions(mission.name)) {
    view[`question:${question.id}`] = question.state;
    if (question.state === 'open') {
      const { text, context, options, recommended } = question;
      events[`question:${question.id}`] = { kind: 'question', id: question.id, state: 'open', question: { text, context, options, recommended } };
    }
  }
  // The merge into the main branch, once a conflict made it go on without the console (core/merge.js).
  const merge = readMerge(mission.name);
  view.merge = merge ? merge.state : null;
  events.merge = merge && merge.state === 'merged' ? { kind: 'merge', id: mission.name, state: 'merged', target: merge.target } : null;
  // The usage pause: an event while it lasts, and one when it is lifted (a pause seen in the last view).
  const pause = FINISHED.test(mission.state) ? null : readPause(mission.name);
  view.pause = pause ? pause.resumeAt : null;
  if (pause) events.pause = { kind: 'pause', id: mission.name, resumeAt: pause.resumeAt, percent: pausePercent(pause.reason) };
  else if (known && known.pause) events.pause = { kind: 'resume', id: mission.name };
  for (const task of listTasks(mission.name)) {
    view[`task:${task.id}`] = `${task.state}#${task.attempt}`;
    if (task.state === 'failed') {
      events[`task:${task.id}`] = { kind: 'task', id: task.id, state: 'failed', attempt: task.attempt, summary: task.summary || null };
    }
  }
  return { view, events };
}

// The view of every mission, and the events not yet in `before` (null without a snapshot: then a
// mission already over is not an event, only what is open or failed is).
function look(before) {
  const views = {};
  const events = [];
  for (const mission of listMissions()) {
    let seen;
    try {
      seen = viewOfMission(mission, before && before[mission.name]);
    } catch {
      continue; // being written or removed: the next round reads it
    }
    views[mission.name] = seen.view;
    const known = before && before[mission.name];
    for (const [key, event] of Object.entries(seen.events)) {
      if (!event) continue;
      if (known && known[key] === seen.view[key]) continue;
      if (!before && (key === 'mission' || key === 'merge' || event.kind === 'resume')) continue;
      events.push({ mission: mission.name, ...event });
    }
  }
  return { views, events };
}

// Gives the events to `report` as soon as there are some, or [] after the timeout (none: no limit;
// 0: look once). The snapshot is saved only once `report` has succeeded.
async function waitForEvents(timeoutSeconds, report) {
  // An unreadable snapshot counts as none: a wait that failed for good would be started again and again.
  let before = null;
  try {
    before = readJson(snapshotFile(), {}).missions || null;
  } catch {
    // none
  }
  const deadline = timeoutSeconds === undefined ? Infinity : Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const { views, events } = look(before);
    if (events.length > 0 || Date.now() >= deadline) {
      report(events);
      writeJson(snapshotFile(), { missions: views });
      return events;
    }
    await sleep(POLL_MS);
  }
}

module.exports = { waitForEvents };
