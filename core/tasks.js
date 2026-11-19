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
const { getAdapter } = require('../adapters');
const { getDelivery } = require('../deliveries');
const tasksDirSource = require('../sources/tasks-dir');
const { withMissionLock } = require('./mission-lock');

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
  const integration = path.join(mission.dir, '.relaylead', 'worktrees', '_integration');
  return fs.existsSync(integration) ? integration : mission.dir;
}

function readSource(mission) {
  const source = mission.config.source;
  if (source.type !== 'tasks-dir') throw new Error(`unknown task source "${source.type}"`);
  return tasksDirSource.list(sourceRoot(mission), source.dir);
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
// _integration is the integration worktree's folder.
function checkTaskId(task) {
  const usable = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(task.id) && !task.id.includes('..') && !task.id.endsWith('.') && !task.id.endsWith('.lock');
  if (!usable || task.id === '_integration') throw codedError('bad-task-id', { file: task.file });
}

// Each task with its state, and `ready`: todo with every dependency delivered. A task only done
// is not in the integration branch yet, so a task built on it could not see its work.
function listTasks(name) {
  const mission = readMission(name);
  const tasks = readSource(mission).map((sourceTask) => {
    const record = readJson(taskFile(name, sourceTask.id), null);
    const result = resultOfAttempt(record, readJson(resultFile(name, sourceTask.id), null));
    return {
      ...sourceTask,
      state: taskState(sourceTask, record, result),
      profile: record ? record.profile : null,
      session: record ? record.session : null,
      attempt: record ? currentAttempt(record) : 0,
      summary: (result || record || {}).summary || null,
    };
  });
  tasks.forEach(checkTaskId);
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

function crewPrompt(task, cwd, branch, question, attempt, previousSummary) {
  // The crew member cannot read the questions: the answer it needs comes with its task.
  const asked = question
    ? [`Question asked before this task: ${question.text}`, `Answer from the user: ${question.answer.choice}`, '']
    : [];
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

function checkMissionOpen(name) {
  const state = getState(name);
  if (state === 'stopped') throw codedError('mission-stopped', { mission: name });
  if (state === 'done') throw codedError('mission-done', { mission: name });
}

// At most mission.config.parallel tasks run at a time. The task `id` itself is not counted: a retry
// that takes up its own interrupted attempt finds it running already.
function checkParallelLimit(mission, tasks, id) {
  const running = tasks.filter((task) => task.state === 'running' && task.id !== id).map((task) => task.id);
  const limit = mission.config.parallel;
  if (running.length >= limit) throw codedError('parallel-limit', { mission: mission.name, limit, running: running.join(', ') });
}

// A retry (attempt > 1) launches on a task left running without a session by retryTask.
async function launchCrew(mission, id, profile, { attempt = 1, previousSummary = null } = {}) {
  const name = mission.name;
  checkMissionOpen(name);
  const tasks = listTasks(name);
  const task = findTask(name, id, tasks);
  const retrying = attempt > 1 && task.state === 'running' && task.session === null;
  if (task.state === 'running' && !retrying) return readJson(taskFile(name, id));
  if (task.state !== 'todo' && !retrying) throw codedError('task-not-startable', { id, state: task.state });
  checkParallelLimit(mission, tasks, id);
  // Checked before the task's folder or branch is made, so a refusal leaves nothing behind.
  checkDependencies(tasks, task);
  const question = answeredQuestion(name, task);
  const crewProfile = loadProfile(profile, { dir: mission.dir });

  const { cwd, branch } = getDelivery(mission.config.delivery.type).prepareTask(mission, task);
  const number = listSessions(name).filter((s) => s.name.startsWith(`${name}/${profile}/`)).length + 1;
  const adapter = getAdapter(mission.agent);
  const sessionName = `${name}/${profile}/${number}`;
  const launch = async () => {
    const launched = await adapter.launch({
      mission: name,
      name: sessionName,
      role: 'crew',
      profile: crewProfile,
      prompt: crewPrompt(task, cwd, branch, question, attempt, previousSummary),
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
  const session = await launchWhileOpen(name, launch, (launched) => adapter.stop(launched));
  const record = { id, profile, state: 'running', session: session.shortId, cwd, branch, startedAt: now(), attempt };
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
    if (task.state === 'running' && record.session) return record;
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
  return withMissionLock(name, `task deliver ${id}`, () => {
    checkCurrentLead(name, env);
    const task = findTask(name, id);
    if (task.state === 'delivered') {
      return { outcome: 'already-delivered', warnings: delivery.finish(mission, task, { runHooks }) };
    }
    if (task.state !== 'done') throw codedError('task-not-deliverable', { id, state: task.state });
    return { outcome: 'delivered', warnings: delivery.deliver(mission, task, { runHooks }) };
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

// Called by wait when the crew session ended without a result.
function markFailed(name, id, summary) {
  const record = readJson(taskFile(name, id));
  writeJson(taskFile(name, id), { ...record, state: 'failed', summary, failedAt: now() });
}

module.exports = { listTasks, startTask, retryTask, deliverTask, finishTask, markFailed };
