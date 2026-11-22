// `relaylead merge <mission>`: the user brings the work of a finished mission into the main branch of
// its project. Never automatic (design 0.2, §8 point 1). A conflict leaves nothing half done: the merge
// is cancelled, and a crew member gets the task merge-into-<target>, which brings the target into a
// branch of the integration branch and resolves the conflict there, so it sees both sides. Once it
// is done, the watcher delivers it into the integration branch and merges again, without the lead
// (no tokens spent for one task). When the crew member fails, the user is asked what to do.
// merge.json, written here alone, under the mission lock: {state: 'resolving' | 'asked' | 'paused' |
// 'merged', target, task, attempts (resolutions started), conflicts, hints, question, title, body, at}.
const fs = require('node:fs');
const path = require('node:path');
const { missionDir, slug } = require('./paths');
const { readJson, writeJson } = require('./store');
const { codedError } = require('./messages');
const { readMission, stopSessionsAndWait, forgetSessions, removeMission } = require('./missions');
const { listTasks, startMergeTask, deliverMergeTask, markFailed } = require('./tasks');
const { unseenChanges } = require('./wait');
const { getAdapter } = require('../adapters');
const { listSessions } = require('./sessions');
const { askQuestion, listQuestions } = require('./questions');
const { listTold } = require('./told');
const { notify } = require('./notify');
const { watchLog } = require('./watch-log');
const { withMissionLock, withRepoLock } = require('./mission-lock');
const layout = require('./layout');
const { getDelivery } = require('../deliveries');

// Resolutions started by the watcher itself, when the merge conflicts again after one was delivered
// (the target moved meanwhile); past them, the user is asked.
const MAX_RESOLUTIONS = 2;
// The options of the question asked when a resolution fails, in this order (core/merge.js followAnswer).
const OPTIONS = ['Resolve it here with me', 'Relaunch a crew member with hints', 'Pause the mission'];

function now() {
  return new Date().toISOString();
}

function mergeFile(name) {
  return path.join(missionDir(name), 'merge.json');
}

// merge.json, or null when the mission was never merged (or the file is being written).
function readMerge(name) {
  try {
    return readJson(mergeFile(name), null);
  } catch {
    return null;
  }
}

function writeMerge(name, merge) {
  writeJson(mergeFile(name), { ...merge, at: now() }, { createDir: false });
}

function mergeTaskId(target) {
  return `merge-into-${slug(target)}`;
}

// What the crew member merges: the target, or for GitHub the target as the remote has it.
function mergedRef(mission, target) {
  if (mission.config.delivery.type !== 'github-pr') return target;
  return `${mission.config.delivery.remote || 'origin'}/${target}`;
}

// The instructions of the task that resolves the conflict.
function taskBody(mission, merge) {
  const ref = mergedRef(mission, merge.target);
  const fetch = ref === merge.target ? '' : `\`git fetch ${ref.split('/')[0]}\`, then `;
  return [
    `Relaylead could not merge the work of mission ${mission.name} (branch ${mission.config.delivery.branch}) into ${merge.target}: they conflict. Your branch starts from that integration branch.`,
    '',
    `1. Run ${fetch}\`git merge ${ref}\`.`,
    `2. Resolve each conflict keeping what both sides meant: read both versions (\`git diff\`, \`git log --merge -p <file>\`), and never drop the work of either side. Files in conflict when Relaylead tried: ${merge.conflicts.length > 0 ? merge.conflicts.join(', ') : 'see git status'}.`,
    "3. Run the project's tests and fix what the merge broke.",
    '4. Commit the merge on your branch.',
    ...(merge.hints ? ['', `Hints from the user: ${merge.hints}`] : []),
  ].join('\n');
}

// The mission must be done, its sessions stopped: the work to merge is all delivered.
function checkDone(name) {
  const record = readJson(path.join(missionDir(name), 'state.json'), { state: 'starting' });
  if (record.state !== 'done' || record.stopping) throw codedError('merge-not-done', { mission: name, state: record.state });
}

// `relaylead merge <mission>`. Returns {outcome: 'merged' | 'already', target, sha, url} or
// {outcome: 'conflict', target, task, conflicts, queued}.
async function mergeMission(name) {
  const mission = readMission(name);
  const delivery = getDelivery(mission.config.delivery.type);
  if (!delivery.mergeIntoTarget) throw codedError('merge-not-git', { mission: name, type: mission.config.delivery.type });
  checkDone(name);
  return withMissionLock(name, 'merge', async () => {
    checkDone(name);
    const current = readMerge(name);
    if (current && current.state === 'resolving') throw codedError('merge-resolving', { mission: name, task: current.task });
    const target = delivery.mergeTarget(mission);
    if (!target) throw codedError('merge-no-target', { mission: name });
    return tryMerge(mission, target, current);
  });
}

// Under the mission lock: the merge itself, under the git lock. On a conflict, a resolution starts;
// `byWatcher`: past MAX_RESOLUTIONS, the user is asked instead.
async function tryMerge(mission, target, current, { byWatcher = false } = {}) {
  const name = mission.name;
  const delivery = getDelivery(mission.config.delivery.type);
  const result = await withRepoLock(mission.dir, 'merge', () => delivery.mergeIntoTarget(mission, target));
  if (result.outcome !== 'conflict') {
    // The resolution task, if any, stays described: its record says it is delivered.
    writeMerge(name, { ...(current || {}), state: 'merged', target, sha: result.sha || null, url: result.url || null });
    watchLog(name, 'merged', `into ${target}${result.sha ? ` (${result.sha})` : ''}${result.url ? ` ${result.url}` : ''}`);
    if (byWatcher) notify({ title: `Relaylead: ${name}`, text: `Mission ${name} merged into ${target}` });
    return { ...result, target };
  }
  const attempts = current && current.state !== 'merged' ? current.attempts || 0 : 0;
  const conflicts = result.conflicts || [];
  if (byWatcher && attempts >= MAX_RESOLUTIONS) {
    askUser(mission, { ...current, conflicts }, `the merge still conflicts after ${attempts} resolutions`);
    return { outcome: 'conflict', target, task: current.task, conflicts, queued: false };
  }
  return startResolution(mission, { target, conflicts, attempts, hints: null });
}

// Writes merge.json for a new resolution, then starts its crew member (queued without a free place).
async function startResolution(mission, { target, conflicts, attempts, hints }) {
  const merge = { state: 'resolving', target, task: mergeTaskId(target), attempts: attempts + 1, conflicts, hints: hints || null };
  merge.title = `Resolve the conflict between mission ${mission.name} and ${target}`;
  merge.body = taskBody(mission, merge);
  writeMerge(mission.name, merge);
  const record = await startMergeTask(mission, merge.task);
  watchLog(mission.name, 'merge-conflict', `with ${target}: task ${merge.task} ${record.state}`);
  return { outcome: 'conflict', target, task: merge.task, conflicts, queued: record.state === 'queued' };
}

// The crew member of a finished resolution task: stopped, then out of the agent's list.
async function stopCrew(mission, shortId) {
  const session = listSessions(mission.name).find((candidate) => candidate.shortId === shortId);
  if (!session) return;
  await stopSessionsAndWait(mission, [session]);
  await forgetSessions(mission, [session]);
}

// Why the crew member of the running resolution task counts as ended without a result, or null while
// it may still work. The criteria of `relaylead wait` (core/wait.js): ended for the agent, or lost
// past a grace, whose start is kept in merge.json (crewLostSince). A list that fails says nothing.
async function lostCrew(mission, merge, task) {
  let rows;
  try {
    rows = await getAdapter(mission.agent).list(mission.name);
  } catch {
    return null;
  }
  const { toFail, lostSince } = unseenChanges(mission.name, rows, merge.crewLostSince || {}, Date.now());
  writeMerge(mission.name, { ...merge, crewLostSince: lostSince });
  const lost = toFail.find((entry) => entry.id === task.id);
  return lost ? lost.summary : null;
}

// The question to the user when a resolution fails; its context says how to resolve by hand.
function askUser(mission, merge, why) {
  const ref = mergedRef(mission, merge.target);
  const files = merge.conflicts && merge.conflicts.length > 0 ? merge.conflicts.join(', ') : 'see git status';
  const { id } = askQuestion(mission.name, {
    key: `merge-${slug(merge.target)}-${merge.attempts}`,
    text: `The merge of mission ${mission.name} into ${merge.target} conflicts, and the crew member could not resolve it (${why || 'no summary'}). What now?`,
    context:
      `Files in conflict: ${files}. To resolve it here: in ${layout.integrationDir(mission)}, run git merge ${ref}, fix the conflicts, run the tests and commit; then run relaylead merge ${mission.name}. ` +
      `To give hints to a new crew member, send them first with relaylead tell ${mission.name} "<hints>".`,
    options: OPTIONS,
    recommended: 1,
  });
  writeMerge(mission.name, { ...merge, state: 'asked', question: id });
  watchLog(mission.name, 'merge-asked', id);
}

// The watcher's part, after each pass (core/watcher.js): goes on with a merge being resolved. The
// resolution task done: delivered into the integration branch, its crew member stopped, and the merge
// tried again. Failed: the user is asked. The question answered: done as the user chose.
async function tendMerge(name) {
  const first = readMerge(name);
  if (!first || !['resolving', 'asked'].includes(first.state)) return;
  await withMissionLock(name, 'watcher merge', async () => {
    const merge = readMerge(name);
    if (!merge || !['resolving', 'asked'].includes(merge.state)) return;
    const mission = readMission(name);
    if (merge.state === 'asked') return followAnswer(mission, merge);
    let task = listTasks(name).find((candidate) => candidate.id === merge.task);
    // No lead waits on a done mission: a crew member that ended without a result is failed here.
    if (task && task.state === 'running') {
      const summary = await lostCrew(mission, merge, task);
      if (!summary) return;
      markFailed(name, task.id, summary);
      watchLog(name, 'crew-lost', `${task.session || '-'} task ${task.id}`);
      task = { ...task, state: 'failed', summary };
    }
    if (!task || !['done', 'failed'].includes(task.state)) return;
    await stopCrew(mission, task.session);
    if (task.state === 'failed') return askUser(mission, merge, task.summary);
    try {
      await deliverMergeTask(mission, task);
    } catch (err) {
      return askUser(mission, merge, `its work could not be delivered: ${err.message}`);
    }
    await tryMerge(mission, merge.target, merge, { byWatcher: true });
  });
}

// The answer to the question of a failed resolution: a new crew member with the hints the user told
// the mission since the question, or a pause (the user resolves it, or merges later).
async function followAnswer(mission, merge) {
  const question = listQuestions(mission.name).find((candidate) => candidate.id === merge.question);
  if (!question || question.state !== 'answered') return;
  const choice = question.answer.choice;
  if (choice !== OPTIONS[1]) {
    writeMerge(mission.name, { ...merge, state: 'paused', choice });
    watchLog(mission.name, 'merge-paused', choice);
    return;
  }
  const told = listTold(mission.name).filter((message) => message.at >= question.askedAt);
  const hints = told.map((message) => message.text).join(' ') || null;
  await startResolution(mission, { target: merge.target, conflicts: merge.conflicts || [], attempts: merge.attempts || 0, hints });
}

// The cleanup of the watcher, at each full pass (core/watcher.js): a finished mission of 0.2 delivered
// by git, whose integration branch is merged (by `relaylead merge`, or by hand: its tip, past the commit
// it started from, is in the branch it merges into) or deleted, is removed as by `relaylead remove`,
// without --force, with its clean integration worktree; the integration branch stays. Not while a
// merge is being resolved, asked about or paused, nor while the helper `_reap` may still run. A
// removal refused (work not delivered) is noted once in cleanup.json, and the mission stays. Returns
// how the branch left ('merged' or 'deleted') once the mission is removed, otherwise null.
async function removeIfMerged(name) {
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  const folder = missionDir(name);
  let mission;
  try {
    mission = readJson(path.join(folder, 'mission.json'), null);
  } catch {
    return null; // unreadable: its pass has reported it
  }
  if (!mission || !layout.isPerMission(mission)) return null;
  const delivery = getDelivery(mission.config.delivery.type);
  if (!delivery.integrationState || !fs.existsSync(mission.dir)) return null;
  const record = readJson(path.join(folder, 'state.json'), { state: 'starting' });
  if (!['done', 'stopped'].includes(record.state) || record.stopping) return null;
  if (fs.existsSync(path.join(folder, 'reaper.json')) && !fs.existsSync(path.join(folder, 'reaper-ended.json'))) return null;
  if (fs.existsSync(path.join(folder, 'cleanup.json'))) return null;
  const merge = readMerge(name);
  if (merge && merge.state !== 'merged') return null;
  const how = merge ? 'merged' : delivery.integrationState(mission);
  if (!how) return null;
  try {
    await removeMission(name, { integrationWorktree: true });
  } catch (err) {
    if (!['remove-unmerged-work', 'checkout-on-task-branch'].includes(err.code)) throw err;
    writeJson(path.join(folder, 'cleanup.json'), { refusedAt: now(), reason: err.message }, { createDir: false });
    watchLog(name, 'cleanup-refused', err.message);
    return null;
  }
  watchLog(name, 'mission-removed', `integration branch ${how}`);
  return how;
}

// Whether a merge needs the mission's crew: a resolution under way, or a question waiting for an answer.
function mergeOngoing(name) {
  const merge = readMerge(name);
  return Boolean(merge) && ['resolving', 'asked'].includes(merge.state);
}

module.exports = { mergeMission, tendMerge, removeIfMerged, readMerge, mergeOngoing, OPTIONS, MAX_RESOLUTIONS };
