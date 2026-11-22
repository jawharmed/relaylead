// Tasks of a mission: the source says what to do, the core tracks who does it.
// tasks/<id>.json is written by the core, tasks/<id>.result.json by the crew member only.
// A retried task keeps its earlier attempts in tasks/archive/<id>.<n>.json and <id>.<n>.result.json.
const fs = require('node:fs');
const path = require('node:path');
const { home, missionDir, slug } = require('./paths');
const { writeJson, readJson, withWindowsRetry } = require('./store');
const { codedError } = require('./messages');
const { DEFAULTS } = require('./config');
const { readMission, getState, stopSessionsAndWait, launchWhileOpen, currentLeadError } = require('./missions');
const { recordSession, listSessions } = require('./sessions');
const { loadProfile } = require('./profiles');
const { listQuestions } = require('./questions');
const { listTold } = require('./told');
const { getAdapter } = require('../adapters');
const { getDelivery } = require('../deliveries');
const tasksDirSource = require('../sources/tasks-dir');
const githubIssuesSource = require('../sources/github-issues');
const { withMissionLock, withPlacesLock, withRepoLock } = require('./mission-lock');
const { placeFree, placesTaken, maxSessions, queue } = require('./places');
const layout = require('./layout');

// The option the lead adds to the question of a task that asks first (catalog/profiles/lead.md).
const SKIP_CHOICE = 'Skip this task';

function now() {
  return new Date().toISOString();
}

function taskFile(mission, id) {
  return path.join(missionDir(mission), 'tasks', `${id}.json`);
}

function resultFile(mission, id) {
  return path.join(missionDir(mission), 'tasks', `${id}.result.json`);
}

function archivedTaskFile(mission, id, attempt) {
  return path.join(missionDir(mission), 'tasks', 'archive', `${id}.${attempt}.json`);
}

function archivedResultFile(mission, id, attempt) {
  return path.join(missionDir(mission), 'tasks', 'archive', `${id}.${attempt}.result.json`);
}

// A record or result written before attempts were counted is the first attempt.
function currentAttempt(record) {
  return (record && record.attempt) || 1;
}

// The crew's result, unless it comes from another attempt than the record's: a crew member replaced
// by a retry may still write one. That one does not count.
function resultOfAttempt(record, result) {
  return result && currentAttempt(result) === currentAttempt(record) ? result : null;
}

// Once delivery has created the integration worktree, the source is read there.
function sourceRoot(mission) {
  const integration = layout.integrationDir(mission);
  return fs.existsSync(integration) ? integration : mission.dir;
}

function readSource(mission) {
  const source = mission.config.source;
  if (source.type === 'tasks-dir') return tasksDirSource.list(sourceRoot(mission), source.dir);
  if (source.type === 'github-issues') return githubIssuesSource.list(source, { cwd: mission.dir });
  throw new Error(`unknown task source "${source.type}": use tasks-dir or github-issues`);
}

// The task that resolves the conflict of `relaylead merge` (core/merge.js), described by merge.json;
// null when there is none. Its record says when it is delivered: it has no file in the task folder.
function mergeTaskOf(mission) {
  let merge;
  try {
    merge = readJson(path.join(missionDir(mission.name), 'merge.json'), null);
  } catch {
    return null; // being written: the next read has it
  }
  if (!merge || !merge.task) return null;
  return { id: merge.task, title: merge.title, body: merge.body, depends: [], ask: null, merge: true, file: 'merge.json' };
}

// The tasks of the source, then the task resolving a merge conflict.
function allTasks(mission) {
  const tasks = readSource(mission);
  const merge = mergeTaskOf(mission);
  return merge ? [...tasks, merge] : tasks;
}

// Delivered when the source says done (local-merge marks it there) or the record says delivered
// (files delivery). Otherwise the crew's result of the current attempt, then the core's record.
function taskState(sourceTask, record, result) {
  if (sourceTask.state === 'done') return 'delivered';
  if (record && record.state === 'delivered') return 'delivered';
  if (result) return result.state;
  if (record) return record.state;
  return 'todo';
}

// The id goes into a git branch name (relaylead/<mission>/<id>) and a worktree folder name;
// _integration is the integration worktree's folder, and since 0.2 relaylead/<mission>/integration
// is the integration branch; _merge is the worktree of `relaylead merge`, and merge-into-… the ids
// of the tasks resolving its conflicts.
function checkTaskId(mission, task) {
  const usable = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(task.id) && !task.id.includes('..') && !task.id.endsWith('.') && !task.id.endsWith('.lock');
  const mergeId = !task.merge && (task.id === '_merge' || task.id.startsWith('merge-into-'));
  const reserved = mergeId || task.id === '_integration' || (layout.isPerMission(mission) && task.id === 'integration');
  if (!usable || reserved) throw codedError('bad-task-id', { file: task.file });
}

// Each task with its state, and `ready`: todo with every dependency delivered. A task only done
// is not in the integration branch yet, so a task built on it could not see its work.
function listTasks(name) {
  const mission = readMission(name);
  const tasks = allTasks(mission).map((sourceTask) => {
    const record = readJson(taskFile(name, sourceTask.id), null);
    const result = resultOfAttempt(record, readJson(resultFile(name, sourceTask.id), null));
    return {
      ...sourceTask,
      state: taskState(sourceTask, record, result),
      profile: record ? record.profile : null,
      session: record ? record.session : null,
      attempt: record ? currentAttempt(record) : 0,
      summary: (result || record || {}).summary || null,
      // The ids of the messages told to the mission that its crew member got with its task.
      told: record && record.told ? record.told : [],
    };
  });
  tasks.forEach((task) => checkTaskId(mission, task));
  tasksDirSource.checkDependencies(tasks);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    task.ready =
      task.state === 'todo' && task.depends.every((dep) => byId.get(dep).state === 'delivered');
  }
  return tasks;
}

function findTask(name, id, tasks = listTasks(name)) {
  const task = tasks.find((candidate) => candidate.id === id);
  if (!task) throw codedError('task-unknown', { mission: name, id });
  return task;
}

// A task starts once every task it depends on is delivered (see `ready` in listTasks, which has
// already checked that each dependency exists).
function checkDependencies(tasks, task) {
  const missing = task.depends.filter((dep) => tasks.find((candidate) => candidate.id === dep).state !== 'delivered');
  if (missing.length > 0) throw codedError('task-not-ready', { id: task.id, missing: missing.join(', ') });
}

// The question a task with `ask` needed answered before it starts (the lead asks it with the task
// id as key), or null when the task asks nothing. An answer "Skip this task" sets the task aside.
function answeredQuestion(name, task) {
  if (!task.ask) return null;
  const question = listQuestions(name).find((candidate) => candidate.id === `q-${slug(task.id)}`);
  if (!question || question.state !== 'answered') throw codedError('task-not-answered', { id: task.id });
  if (question.answer.choice.trim().toLowerCase() === SKIP_CHOICE.toLowerCase()) {
    throw codedError('task-skipped', { id: task.id });
  }
  return question;
}

function crewPrompt(task, cwd, branch, question, attempt, previousSummary, told) {
  // The crew member cannot read the questions: the answer it needs comes with its task.
  const asked = question
    ? [`Question asked before this task: ${question.text}`, `Answer from the user: ${question.answer.choice}`, '']
    : [];
  // What the user told the mission with `relaylead tell`, from the first message.
  const hints = told.length > 0 ? ['Messages from the user for this mission:', ...told.map((message) => `- ${message.text}`), ''] : [];
  const retried =
    attempt > 1
      ? [
          `Attempt ${attempt}: an earlier attempt failed ("${previousSummary || 'no summary'}"). Its commits, if any, are already on your ` +
            'branch, and its uncommitted leftovers may still be in the folder: run git status first and keep or remove them.',
          '',
        ]
      : [];
  return [
    `Task ${task.id}: ${task.title}`,
    '',
    task.body.trim(),
    '',
    ...asked,
    ...hints,
    ...retried,
    `Working folder: ${cwd}`,
    `Branch: ${branch || 'none'}`,
    '',
    `Finish with \`relaylead task done ${task.id} --summary "<one line>"\` ` +
      `or \`relaylead task fail ${task.id} --summary "<one line>"\`, one command per call.`,
  ].join('\n');
}

// Idempotent: a running task is returned as it is, so a replayed start launches nobody.
// `env` is the caller's: see checkCurrentLead.
async function startTask(name, { id, profile = 'developer', env }) {
  const mission = readMission(name); // before the lock, which lives in the mission folder
  return withMissionLock(name, `task start ${id}`, () => {
    checkCurrentLead(name, env);
    return launchCrew(mission, id, profile);
  });
}

// Checked again under the mission lock: a command that waited for the lock while a relaunch or a
// handover replaced its lead is refused once it gets the lock.
function checkCurrentLead(name, env) {
  const refused = currentLeadError(name, env);
  if (refused) throw refused;
}

// `merge`: the task that resolves a merge conflict (core/merge.js), which runs once the mission is done.
function checkMissionOpen(name, { merge = false } = {}) {
  const state = getState(name);
  if (state === 'stopped') throw codedError('mission-stopped', { mission: name });
  if (state === 'done' && !merge) throw codedError('mission-done', { mission: name });
}

// At most mission.config.parallel tasks run or wait in the queue at a time. The task `id` itself is
// not counted: a retry that takes up its own interrupted attempt finds it running already.
function checkParallelLimit(mission, tasks, id) {
  const running = tasks.filter((task) => ['running', 'queued'].includes(task.state) && task.id !== id).map((task) => task.id);
  const limit = mission.config.parallel;
  if (running.length >= limit) throw codedError('parallel-limit', { mission: mission.name, limit, running: running.join(', ') });
}

// A retry (attempt > 1) launches on a task left running without a session by retryTask. Without a
// free place on the machine (core/places.js), the task is queued instead: its record says `queued`,
// and the watcher starts it later (startQueued, with `fromQueue`). `merge`: the task resolving a merge
// conflict, which runs once the mission is done (core/merge.js).
async function launchCrew(mission, id, profile, { attempt = 1, previousSummary = null, fromQueue = false, merge = false } = {}) {
  const name = mission.name;
  checkMissionOpen(name, { merge });
  const tasks = listTasks(name);
  const task = findTask(name, id, tasks);
  const retrying = attempt > 1 && task.state === 'running' && task.session === null;
  if (task.state === 'running' && !retrying) return readJson(taskFile(name, id));
  if (task.state === 'queued' && !fromQueue) return readJson(taskFile(name, id));
  if (!['todo', 'queued'].includes(task.state) && !retrying) throw codedError('task-not-startable', { id, state: task.state });
  checkParallelLimit(mission, tasks, id);
  // Checked before the task's folder or branch is made, so a refusal leaves nothing behind.
  checkDependencies(tasks, task);
  const question = answeredQuestion(name, task);
  const crewProfile = loadProfile(profile, { dir: mission.dir });
  // The place is chosen and reserved under the places lock, by a record `running` without a session
  // (core/places.js counts it): two starts never take the last place together. The folder and the
  // launch come after, out of that lock, so a busy repository never holds up the other projects.
  const before = readJson(taskFile(name, id), null);
  const queued = await withPlacesLock(`task start ${id}`, () => {
    if (!placeFree(mission, id, { fromQueue })) return queueTask(mission, id, { profile, attempt, previousSummary, merge });
    writeJson(taskFile(name, id), { id, profile, state: 'running', session: null, attempt, reservedAt: now() });
    return null;
  });
  if (queued) return queued;
  try {
    return await launchOnPlace(mission, task, profile, crewProfile, question, { attempt, previousSummary, merge });
  } catch (err) {
    // The place is given back: the task is as it was before this start (a queued one stays queued,
    // a retry's record is written failed by retryTask).
    if (before) writeJson(taskFile(name, id), before);
    else withWindowsRetry(() => fs.rmSync(taskFile(name, id), { force: true }));
    throw err;
  }
}

// The record of a task waiting for a place. Queued again (a place taken meanwhile), it keeps its time.
function queueTask(mission, id, { profile, attempt, previousSummary, merge }) {
  const earlier = readJson(taskFile(mission.name, id), {});
  const queuedAt = earlier.state === 'queued' && earlier.queuedAt ? earlier.queuedAt : now();
  const record = { id, profile, state: 'queued', session: null, attempt, queuedAt };
  if (previousSummary) record.previousSummary = previousSummary;
  if (merge) record.merge = true;
  writeJson(taskFile(mission.name, id), record);
  return record;
}

// Prepares the task's folder and launches its crew member, on a place already taken.
async function launchOnPlace(mission, task, profile, crewProfile, question, { attempt, previousSummary, merge }) {
  const name = mission.name;
  const id = task.id;
  const delivery = getDelivery(mission.config.delivery.type);
  const { cwd, branch } = await withRepoLock(mission.dir, `task start ${id}`, () => delivery.prepareTask(mission, task));
  // The messages of the user come with the task, but for a merge resolution, which has its own hints (core/merge.js).
  const told = merge ? [] : listTold(name);
  const number = listSessions(name).filter((s) => s.name.startsWith(`${name}/${profile}/`)).length + 1;
  const adapter = getAdapter(mission.agent);
  const sessionName = `${name}/${profile}/${number}`;
  const launch = async () => {
    const launched = await adapter.launch({
      mission: name,
      name: sessionName,
      role: 'crew',
      profile: crewProfile,
      prompt: crewPrompt(task, cwd, branch, question, attempt, previousSummary, told),
      cwd,
      env: {
        RELAYLEAD_MISSION: name,
        RELAYLEAD_HOME: home(),
        RELAYLEAD_TASK: id,
        RELAYLEAD_ATTEMPT: String(attempt),
        RELAYLEAD_ROLE: 'crew',
        RELAYLEAD_SESSION: sessionName,
      },
      permissionMode: mission.config.permissionMode,
    });
    try {
      recordSession(name, launched);
    } catch (err) {
      await adapter.stop(launched); // no orphan session
      throw err;
    }
    return launched;
  };
  // The state is read again once the session is recorded: a stop either finds it in the registry or
  // is seen there.
  const session = await launchWhileOpen(name, launch, (launched) => adapter.stop(launched), { allowDone: merge });
  const record = { id, profile, state: 'running', session: session.shortId, cwd, branch, startedAt: now(), attempt, told: told.map((message) => message.id) };
  try {
    writeJson(taskFile(name, id), record);
  } catch (err) {
    await adapter.stop(session); // no orphan session
    throw err;
  }
  return record;
}

// Launches a new crew member on a failed task, as attempt n + 1. Idempotent: a retried task that is
// running is returned as it is. An attempt counted but never launched (a launch that failed, or a
// crash before it) is launched again with the same number, past the limit.
async function retryTask(name, { id, profile, env }) {
  const mission = readMission(name); // before the lock, which lives in the mission folder
  return withMissionLock(name, `task retry ${id}`, async () => {
    checkCurrentLead(name, env);
    checkMissionOpen(name);
    const tasks = listTasks(name);
    const task = findTask(name, id, tasks);
    const record = readJson(taskFile(name, id), { id, profile: 'developer' });
    if ((task.state === 'running' && record.session) || task.state === 'queued') return record;
    let attempt = currentAttempt(record);
    const neverLaunched = ['running', 'failed'].includes(record.state) && record.session === null && attempt > 1;
    if (!neverLaunched) {
      if (task.state !== 'failed') throw codedError('task-not-retryable', { id, state: task.state });
      const max = mission.config.maxAttempts || DEFAULTS.maxAttempts;
      if (attempt >= max) throw codedError('task-retry-limit', { id, max });
    }
    // Checked before anything changes: a refused retry leaves the failed attempt as it is.
    checkParallelLimit(mission, tasks, id);
    if (!neverLaunched) {
      await stopPreviousCrew(mission, id, record.session);
      archiveAttempt(name, id, attempt, record);
      attempt++;
    }
    // From here on, a result of the earlier crew member is refused or ignored.
    writeJson(taskFile(name, id), { ...record, attempt, state: 'running', session: null });
    const earlier = readJson(archivedResultFile(name, id, attempt - 1), null) || readJson(archivedTaskFile(name, id, attempt - 1), {});
    try {
      return await launchCrew(mission, id, profile || record.profile, { attempt, previousSummary: earlier.summary || null });
    } catch (err) {
      // Failed with no session: the lead sees it and can retry this same attempt.
      const summary = `retry launch failed: ${err.message}`;
      writeJson(taskFile(name, id), { ...record, attempt, state: 'failed', session: null, summary });
      throw err;
    }
  });
}

// The earlier crew member may still be at work (a task failed by wait, a crew that reported failed
// and goes on): its process must be gone before its folder and result change hands.
async function stopPreviousCrew(mission, id, shortId) {
  const session = listSessions(mission.name).find((candidate) => candidate.shortId === shortId);
  if (!session) return;
  const { failed, alive } = await stopSessionsAndWait(mission, [session]);
  if (failed.length > 0 || alive.length > 0) throw codedError('crew-still-running', { id, shortId });
}

// The record is copied; the crew's result is moved by a rename, never rewritten. Replayed after a
// crash, it copies the record again and finds no result left to move.
function archiveAttempt(name, id, attempt, record) {
  writeJson(archivedTaskFile(name, id, attempt), record);
  try {
    withWindowsRetry(() => fs.renameSync(resultFile(name, id), archivedResultFile(name, id, attempt)));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err; // a task failed by wait has no result
  }
}

// Delivers a done task. Returns {outcome: 'delivered' or 'already-delivered', warnings}. A task
// already delivered is finished again: that completes a delivery that was interrupted.
// runHooks false skips the git hooks whatever the mission's configuration (the user's --no-hooks).
// `env` is the caller's: see checkCurrentLead.
async function deliverTask(name, id, { runHooks, env } = {}) {
  const mission = readMission(name); // before the lock, which lives in the mission folder
  const delivery = getDelivery(mission.config.delivery.type);
  // The merge and the removals change the repository: under the git lock, inside the mission lock.
  const underRepoLock = (action) => withRepoLock(mission.dir, `task deliver ${id}`, action);
  return withMissionLock(name, `task deliver ${id}`, async () => {
    checkCurrentLead(name, env);
    const task = findTask(name, id);
    if (task.state === 'delivered') {
      return { outcome: 'already-delivered', warnings: await underRepoLock(() => delivery.finish(mission, task, { runHooks })) };
    }
    if (task.state !== 'done') throw codedError('task-not-deliverable', { id, state: task.state });
    const warnings = await underRepoLock(() => delivery.deliver(mission, task, { runHooks }));
    // GitHub: the issue stays open until `relaylead merge`, so the source cannot say the task is delivered: the record does.
    if (mission.config.delivery.type === 'github-pr') {
      writeJson(taskFile(name, id), { ...readJson(taskFile(name, id), {}), state: 'delivered', deliveredAt: now() });
    }
    return { outcome: 'delivered', warnings };
  });
}

// Called by the crew member (`relaylead task done|fail`): it is the only writer of the result.
// Work that could not be delivered is refused now, while the crew member can still fix it: once
// the task is done, its session is stopped. `attempt` is the crew's RELAYLEAD_ATTEMPT: a crew member
// replaced by a retry is refused (and its result ignored if it passes this check during the retry).
function finishTask(name, id, { state, summary, attempt }) {
  const mission = readMission(name);
  const task = findTask(name, id);
  const current = currentAttempt(readJson(taskFile(name, id), null));
  const own = attempt === undefined ? current : Number(attempt);
  if (own !== current) throw codedError('attempt-superseded', { id, attempt: own, current });
  if (state === 'done') getDelivery(mission.config.delivery.type).checkDone(mission, task);
  writeJson(resultFile(name, id), { id, state, summary: summary || null, attempt: own, finishedAt: now() });
}

// Starts the crew member of the task resolving a merge conflict (core/merge.js), as a new attempt when
// an earlier one exists (failed, or delivered before the merge conflicted again). The caller holds the
// mission lock. Returns the task's record: running, or queued without a free place. A launch that
// fails marks the task failed, so the watcher asks the user (core/merge.js); one that met a busy lock
// leaves it todo, and the watcher starts it again at its next pass.
async function startMergeTask(mission, id) {
  const name = mission.name;
  const record = readJson(taskFile(name, id), null);
  if (!record) {
    try {
      return await launchCrew(mission, id, 'developer', { merge: true });
    } catch (err) {
      if (!STILL_QUEUED.includes(err.code)) {
        writeJson(taskFile(name, id), { id, profile: 'developer', attempt: 1, state: 'failed', session: null, summary: `launch failed: ${err.message}` });
      }
      throw err;
    }
  }
  // The state with the crew's result: a crew member that reported its task has left `running`.
  const { state } = findTask(name, id);
  if (state === 'queued' || (state === 'running' && record.session)) return record;
  const profile = record.profile || 'developer';
  await stopPreviousCrew(mission, id, record.session);
  let attempt = currentAttempt(record);
  archiveAttempt(name, id, attempt, record);
  attempt++;
  writeJson(taskFile(name, id), { id, profile, attempt, state: 'running', session: null });
  const earlier = readJson(archivedResultFile(name, id, attempt - 1), null) || record;
  try {
    return await launchCrew(mission, id, profile, { attempt, previousSummary: earlier.summary || null, merge: true });
  } catch (err) {
    writeJson(taskFile(name, id), { id, profile, attempt, state: 'failed', session: null, summary: `launch failed: ${err.message}` });
    throw err;
  }
}

// Delivers the done task resolving a merge conflict into the integration branch (under the git lock),
// then marks its record delivered. The caller holds the mission lock. Returns the delivery's warnings.
async function deliverMergeTask(mission, task) {
  const delivery = getDelivery(mission.config.delivery.type);
  const warnings = await withRepoLock(mission.dir, `merge deliver ${task.id}`, () => delivery.deliver(mission, task, {}));
  const record = readJson(taskFile(mission.name, task.id));
  writeJson(taskFile(mission.name, task.id), { ...record, state: 'delivered', deliveredAt: now() });
  return warnings;
}

// Starts the queued tasks while places are free, the first of the queue first (core/places.js). Run
// by the watcher, after each pass. Each start takes the mission lock, then the places lock (in
// launchCrew). Returns the tasks started, as {mission, id}; `onError(entry, err)` gets each failed start.
async function startQueued({ onError = () => {} } = {}) {
  const started = [];
  for (const entry of queue()) {
    if (placesTaken() >= maxSessions()) break;
    try {
      const record = await withMissionLock(entry.mission, `task start ${entry.id}`, () => startFromQueue(entry.mission, entry.id));
      if (record && record.state === 'running') started.push(entry);
    } catch (err) {
      onError(entry, err);
    }
  }
  return started;
}

// Errors that leave a queued task in the queue: a lock that gave up, the next pass tries again.
const STILL_QUEUED = ['places-busy', 'repo-busy', 'start-busy', 'start-stuck'];

// Launches a queued task, unless it has left the queue meanwhile. A launch that fails marks the task
// failed, with why: the lead sees it and may retry it.
async function startFromQueue(name, id) {
  const mission = readMission(name);
  const record = readJson(taskFile(name, id), null);
  if (!record || record.state !== 'queued') return null;
  const options = { attempt: record.attempt || 1, previousSummary: record.previousSummary || null, fromQueue: true, merge: Boolean(record.merge) };
  try {
    return await launchCrew(mission, id, record.profile || 'developer', options);
  } catch (err) {
    if (!STILL_QUEUED.includes(err.code)) {
      writeJson(taskFile(name, id), { ...record, state: 'failed', session: null, summary: `start from the queue failed: ${err.message}`, failedAt: now() });
    }
    throw err;
  }
}

// Called by wait when the crew session ended without a result.
function markFailed(name, id, summary) {
  const record = readJson(taskFile(name, id));
  writeJson(taskFile(name, id), { ...record, state: 'failed', summary, failedAt: now() });
}

module.exports = { listTasks, startTask, retryTask, deliverTask, finishTask, markFailed, startQueued, startMergeTask, deliverMergeTask };
