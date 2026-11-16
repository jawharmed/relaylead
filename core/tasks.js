// Tasks of a mission: the source says what to do, the core tracks who does it.
// tasks/<id>.json is written by the core, tasks/<id>.result.json by the crew member only.
const fs = require('node:fs');
const path = require('node:path');
const { home, missionDir, slug } = require('./paths');
const { writeJson, readJson } = require('./store');
const { codedError } = require('./messages');
const { readMission, getState } = require('./missions');
const { recordSession, listSessions, isAlive } = require('./sessions');
const { loadProfile } = require('./profiles');
const { listQuestions } = require('./questions');
const { getAdapter } = require('../adapters');
const { getDelivery } = require('../deliveries');
const tasksDirSource = require('../sources/tasks-dir');

// The option the lead adds to the question of a task that asks first (catalog/profiles/lead.md).
const SKIP_CHOICE = 'Skip this task';
// Long enough for a slow agent launch held by another start.
const START_LOCK_WAIT_MS = 60 * 1000;
const EMPTY_LOCK_STALE_MS = 10 * 1000;
// A live holder this old is stuck: every git command of a delivery ends within 5 minutes.
const START_LOCK_STUCK_MS = 10 * 60 * 1000;

function now() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function taskFile(mission, id) {
  return path.join(missionDir(mission), 'tasks', `${id}.json`);
}

function resultFile(mission, id) {
  return path.join(missionDir(mission), 'tasks', `${id}.result.json`);
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
// (files delivery). Otherwise the crew's result, then the core's record.
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
    const result = readJson(resultFile(name, sourceTask.id), null);
    return {
      ...sourceTask,
      state: taskState(sourceTask, record, result),
      profile: record ? record.profile : null,
      session: record ? record.session : null,
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

function crewPrompt(task, cwd, branch, question) {
  // The crew member cannot read the questions: the answer it needs comes with its task.
  const asked = question
    ? [`Question asked before this task: ${question.text}`, `Answer from the user: ${question.answer.choice}`, '']
    : [];
  return [
    `Task ${task.id}: ${task.title}`,
    '',
    task.body.trim(),
    '',
    ...asked,
    `Working folder: ${cwd}`,
    `Branch: ${branch || 'none'}`,
    '',
    `Finish with \`relaylead task done ${task.id} --summary "<one line>"\` ` +
      `or \`relaylead task fail ${task.id} --summary "<one line>"\`, one command per call.`,
  ].join('\n');
}

// Creating the file with 'wx' fails if it exists, so only one caller holds it. On Windows, a lock
// file being deleted cannot be created again for a moment (EPERM): it counts as still held.
// The file says who holds it, so a lock that is never released shows which command is stuck.
function tryCreateLock(file, command) {
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, command, since: now() }), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST' || (process.platform === 'win32' && err.code === 'EPERM')) return false;
    throw err;
  }
}

// The holder of a lock: {pid, command, since, modifiedAt}, pid 0 while its holder is still writing
// the file; null once the lock is gone. A lock written by an older relaylead holds only the pid.
function readLock(file) {
  let text;
  let modifiedAt;
  try {
    text = fs.readFileSync(file, 'utf8');
    modifiedAt = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  let holder = {};
  try {
    holder = JSON.parse(text);
  } catch {
    // empty or partly written
  }
  if (typeof holder === 'number') holder = { pid: holder };
  if (!holder || typeof holder !== 'object') holder = {};
  return {
    pid: Number(holder.pid) || 0,
    command: holder.command || '?',
    since: holder.since || new Date(modifiedAt).toISOString(),
    modifiedAt,
  };
}

// Stale: its holder process is dead, or no holder could be read from it for 10 s (a holder that
// crashed between creating the file and writing its pid). A lock that is gone is not stale.
function isStaleLock(file) {
  const lock = readLock(file);
  if (!lock) return false;
  if (lock.pid) return !isAlive(lock.pid);
  return Date.now() - lock.modifiedAt > EMPTY_LOCK_STALE_MS;
}

// Never throws: on Windows, a file another process is reading cannot always be removed at once.
// A lock left behind this way is taken over once its holder process has ended.
async function removeQuietly(file) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      fs.rmSync(file, { force: true });
      return true;
    } catch {
      await sleep(20 * attempt);
    }
  }
  return false;
}

// Only the holder of the .takeover file may delete a stale lock, after checking again that it is
// stale. Otherwise two takers could both delete it, the second one deleting the lock the first
// one has just created.
async function takeOverStaleLock(file) {
  const guard = file + '.takeover';
  if (!tryCreateLock(guard, 'takeover')) {
    if (isStaleLock(guard)) await removeQuietly(guard);
    return false;
  }
  try {
    return isStaleLock(file) && (await removeQuietly(file));
  } finally {
    await removeQuietly(guard);
  }
}

// One start or delivery at a time per mission: the lead may start tasks in parallel, and each start
// must see the sessions and task records written by the previous one. Deliveries take it too, so
// two git commands never change the same repository at the same time. `command` names the holder
// ("task start a") in the lock file and in the errors of those who wait for it.
// A waiter gives up after a minute; at once if the live holder has held it for too long.
async function withStartLock(name, command, action) {
  const file = path.join(missionDir(name), 'start.lock');
  const giveUpAt = Date.now() + START_LOCK_WAIT_MS;
  while (!tryCreateLock(file, command)) {
    if (isStaleLock(file) && (await takeOverStaleLock(file))) continue;
    const lock = readLock(file);
    if (lock && lock.pid) {
      const holder = { mission: name, command: lock.command, pid: lock.pid, since: lock.since };
      if (Date.now() - Date.parse(lock.since) > START_LOCK_STUCK_MS) throw codedError('start-stuck', holder);
      if (Date.now() > giveUpAt) throw codedError('start-busy', holder);
    }
    await sleep(50);
  }
  try {
    return await action();
  } finally {
    await removeQuietly(file);
  }
}

// Idempotent: a running task is returned as it is, so a replayed start launches nobody.
async function startTask(name, { id, profile = 'developer' }) {
  const mission = readMission(name); // before the lock, which lives in the mission folder
  return withStartLock(name, `task start ${id}`, () => launchCrew(mission, id, profile));
}

async function launchCrew(mission, id, profile) {
  const name = mission.name;
  const state = getState(name);
  if (state === 'stopped') throw codedError('mission-stopped', { mission: name });
  if (state === 'done') throw codedError('mission-done', { mission: name });
  const tasks = listTasks(name);
  const task = findTask(name, id, tasks);
  if (task.state === 'running') return readJson(taskFile(name, id));
  if (task.state !== 'todo') throw codedError('task-not-startable', { id, state: task.state });
  // Checked before the task's folder or branch is made, so a refusal leaves nothing behind.
  checkDependencies(tasks, task);
  const question = answeredQuestion(name, task);
  const crewProfile = loadProfile(profile, { dir: mission.dir });

  const { cwd, branch } = getDelivery(mission.config.delivery.type).prepareTask(mission, task);
  const number = listSessions(name).filter((s) => s.name.startsWith(`${name}/${profile}/`)).length + 1;
  const adapter = getAdapter(mission.agent);
  const session = await adapter.launch({
    mission: name,
    name: `${name}/${profile}/${number}`,
    role: 'crew',
    profile: crewProfile,
    prompt: crewPrompt(task, cwd, branch, question),
    cwd,
    env: { RELAYLEAD_MISSION: name, RELAYLEAD_HOME: home(), RELAYLEAD_TASK: id },
    permissionMode: mission.config.permissionMode,
  });
  const record = { id, profile, state: 'running', session: session.shortId, cwd, branch, startedAt: now() };
  try {
    recordSession(name, session);
    // Checked once the session is recorded: a stop either finds it in the registry or is seen here.
    if (getState(name) === 'stopped') throw codedError('mission-stopped', { mission: name });
    writeJson(taskFile(name, id), record);
  } catch (err) {
    await adapter.stop(session); // no orphan session
    throw err;
  }
  return record;
}

// Delivers a done task. Returns {outcome: 'delivered' or 'already-delivered', warnings}. A task
// already delivered is finished again: that completes a delivery that was interrupted.
async function deliverTask(name, id) {
  const mission = readMission(name); // before the lock, which lives in the mission folder
  const delivery = getDelivery(mission.config.delivery.type);
  return withStartLock(name, `task deliver ${id}`, () => {
    const task = findTask(name, id);
    if (task.state === 'delivered') return { outcome: 'already-delivered', warnings: delivery.finish(mission, task) };
    if (task.state !== 'done') throw codedError('task-not-deliverable', { id, state: task.state });
    return { outcome: 'delivered', warnings: delivery.deliver(mission, task) };
  });
}

// Called by the crew member (`relaylead task done|fail`): it is the only writer of the result.
// Work that could not be delivered is refused now, while the crew member can still fix it: once
// the task is done, its session is stopped.
function finishTask(name, id, { state, summary }) {
  const mission = readMission(name);
  const task = findTask(name, id);
  if (state === 'done') getDelivery(mission.config.delivery.type).checkDone(mission, task);
  writeJson(resultFile(name, id), { id, state, summary: summary || null, finishedAt: now() });
}

// Called by wait when the crew session ended without a result.
function markFailed(name, id, summary) {
  const record = readJson(taskFile(name, id));
  writeJson(taskFile(name, id), { ...record, state: 'failed', summary, failedAt: now() });
}

module.exports = { listTasks, startTask, deliverTask, finishTask, markFailed };
