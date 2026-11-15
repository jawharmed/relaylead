// Tasks of a mission: the source says what to do, the core tracks who does it.
// tasks/<id>.json is written by the core, tasks/<id>.result.json by the crew member only.
const fs = require('node:fs');
const path = require('node:path');
const { home, missionDir } = require('./paths');
const { writeJson, readJson } = require('./store');
const { codedError } = require('./messages');
const { readMission, getState } = require('./missions');
const { recordSession, listSessions, isAlive } = require('./sessions');
const { getAdapter } = require('../adapters');
const tasksDirSource = require('../sources/tasks-dir');

// Long enough for a slow agent launch held by another start.
const START_LOCK_WAIT_MS = 60 * 1000;
const EMPTY_LOCK_STALE_MS = 10 * 1000;

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

// The source has the last word (done there means delivered), then the crew's result, then the core's record.
function taskState(sourceTask, record, result) {
  if (sourceTask.state === 'done') return 'delivered';
  if (result) return result.state;
  if (record) return record.state;
  return 'todo';
}

// Each task with its state, and `ready`: todo with every dependency done or delivered.
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
  tasksDirSource.checkDependencies(tasks);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    task.ready =
      task.state === 'todo' && task.depends.every((dep) => ['done', 'delivered'].includes(byId.get(dep).state));
  }
  return tasks;
}

function findTask(name, id) {
  const task = listTasks(name).find((candidate) => candidate.id === id);
  if (!task) throw codedError('task-unknown', { mission: name, id });
  return task;
}

function crewPrompt(task, cwd, branch) {
  return [
    `Task ${task.id}: ${task.title}`,
    '',
    task.body.trim(),
    '',
    `Working folder: ${cwd}`,
    `Branch: ${branch || 'none'}`,
    '',
    `Finish with \`relaylead task done ${task.id} --summary "<one line>"\` ` +
      `or \`relaylead task fail ${task.id} --summary "<one line>"\`, one command per call.`,
  ].join('\n');
}

// Creating the file with 'wx' fails if it exists, so only one caller holds it. On Windows, a lock
// file being deleted cannot be created again for a moment (EPERM): it counts as still held.
function tryCreateLock(file) {
  try {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST' || (process.platform === 'win32' && err.code === 'EPERM')) return false;
    throw err;
  }
}

// Stale: its holder process is dead, or no holder could be read from it for 10 s (a holder that
// crashed between creating the file and writing its pid). A lock that is gone is not stale.
function isStaleLock(file) {
  let text;
  let modifiedAt;
  try {
    text = fs.readFileSync(file, 'utf8');
    modifiedAt = fs.statSync(file).mtimeMs;
  } catch {
    return false;
  }
  const holder = Number(text);
  if (holder) return !isAlive(holder);
  return Date.now() - modifiedAt > EMPTY_LOCK_STALE_MS;
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
  if (!tryCreateLock(guard)) {
    if (isStaleLock(guard)) await removeQuietly(guard);
    return false;
  }
  try {
    return isStaleLock(file) && (await removeQuietly(file));
  } finally {
    await removeQuietly(guard);
  }
}

// One start at a time per mission: the lead may start tasks in parallel, and each start must see
// the sessions and task records written by the previous one.
async function withStartLock(name, action) {
  const file = path.join(missionDir(name), 'start.lock');
  const giveUpAt = Date.now() + START_LOCK_WAIT_MS;
  while (!tryCreateLock(file)) {
    if (isStaleLock(file) && (await takeOverStaleLock(file))) continue;
    if (Date.now() > giveUpAt) throw codedError('start-busy', { mission: name });
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
  return withStartLock(name, () => launchCrew(mission, id, profile));
}

async function launchCrew(mission, id, profile) {
  const name = mission.name;
  if (getState(name) === 'stopped') throw codedError('mission-stopped', { mission: name });
  const task = findTask(name, id);
  if (task.state === 'running') return readJson(taskFile(name, id));
  if (task.state !== 'todo') throw codedError('task-not-startable', { id, state: task.state });

  const cwd = mission.dir; // Task 6: the delivery prepares the place of work
  const branch = null;
  const number = listSessions(name).filter((s) => s.name.startsWith(`${name}/${profile}/`)).length + 1;
  const adapter = getAdapter(mission.agent);
  const session = await adapter.launch({
    mission: name,
    name: `${name}/${profile}/${number}`,
    role: 'crew',
    profile: { name: profile },
    prompt: crewPrompt(task, cwd, branch),
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

// Called by the crew member (`relaylead task done|fail`): it is the only writer of the result.
function finishTask(name, id, { state, summary }) {
  findTask(name, id);
  writeJson(resultFile(name, id), { id, state, summary: summary || null, finishedAt: now() });
}

// Called by wait when the crew session ended without a result.
function markFailed(name, id, summary) {
  const record = readJson(taskFile(name, id));
  writeJson(taskFile(name, id), { ...record, state: 'failed', summary, failedAt: now() });
}

module.exports = { listTasks, startTask, finishTask, markFailed };
