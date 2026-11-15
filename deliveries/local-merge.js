// Delivery "branch merged locally". Each task gets its own branch and worktree; a finished task is
// merged into the integration branch, in the integration worktree. All merges and all writes to the
// task source happen there: the user's own checkout never changes.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { codedError } = require('../core/messages');
const tasksDirSource = require('../sources/tasks-dir');

// Never through a shell: paths may contain spaces. Git's own output is kept for the error message.
function git(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
  } catch (err) {
    const detail = String(err.stderr || err.stdout || err.message).trim();
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
}

// show-ref exits with 1 when the branch does not exist. Unlike `git branch --list`, it reads no pattern.
function branchExists(dir, branch) {
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: dir,
      stdio: 'ignore',
      windowsHide: true,
    });
    return true;
  } catch (err) {
    if (err.status === 1) return false;
    throw err;
  }
}

function currentBranch(cwd) {
  return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

function worktreesDir(mission) {
  return path.join(mission.dir, '.relaylead', 'worktrees');
}

function integrationDir(mission) {
  return path.join(worktreesDir(mission), '_integration');
}

function taskDir(mission, task) {
  return path.join(worktreesDir(mission), task.id);
}

function taskBranch(mission, task) {
  return `relaylead/${mission.name}/${task.id}`;
}

// The task's file in the source, with forward slashes, as git pathspecs expect.
function sourceFile(mission, task) {
  return `${mission.config.source.dir}/${task.id}.md`;
}

// So the worktrees under .relaylead/ never show in the user's `git status`. The common dir is the
// main .git folder, even when `dir` is itself a worktree.
function excludeRelaylead(dir) {
  const commonDir = path.resolve(dir, git(dir, ['rev-parse', '--git-common-dir']));
  const file = path.join(commonDir, 'info', 'exclude');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (text.split(/\r?\n/).includes('.relaylead/')) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const separator = text === '' || text.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(file, `${separator}.relaylead/\n`);
}

// Git cannot have both a branch a/b and a branch a/b/c: the integration branch must not be, or
// contain, the folder of the task branches relaylead/<mission>/<id>.
function branchesClash(branch, missionName) {
  const tasksFolder = `relaylead/${missionName}`;
  return branch === tasksFolder || branch.startsWith(tasksFolder + '/') || tasksFolder.startsWith(branch + '/');
}

// Checks everything before changing anything, then creates the integration branch from the current
// branch, and its worktree. A later mission on the same folder reuses them.
function prepareMission(mission) {
  const { branch } = mission.config.delivery;
  const sourceDir = mission.config.source.dir;
  if (mission.config.guard.protectedBranches.includes(branch)) {
    throw codedError('protected-branch', { branch });
  }
  if (branchesClash(branch, mission.name)) {
    throw codedError('branch-clash', { branch, mission: mission.name });
  }
  if (!fs.existsSync(path.join(mission.dir, '.git'))) {
    throw codedError('not-a-git-repo', { dir: mission.dir });
  }
  // The crew members work from commits: uncommitted tasks would not reach them.
  if (git(mission.dir, ['status', '--porcelain', '--', sourceDir]) !== '') {
    throw codedError('tasks-not-committed', { dir: sourceDir, branch });
  }
  const integration = integrationDir(mission);
  if (fs.existsSync(integration) && currentBranch(integration) !== branch) {
    throw codedError('integration-mismatch', { dir: integration, actual: currentBranch(integration), branch });
  }

  excludeRelaylead(mission.dir);
  if (!fs.existsSync(integration)) {
    // `git branch` does not check the branch out: the user's checkout stays as it is.
    if (!branchExists(mission.dir, branch)) git(mission.dir, ['branch', branch]);
    git(mission.dir, ['worktree', 'add', integration, branch]);
  }
  if (!fs.existsSync(path.join(integration, sourceDir))) {
    throw codedError('tasks-not-committed', { dir: sourceDir, branch });
  }
}

// A worktree folder that exists must be this task's: it may have been left by an older mission.
function checkTaskWorktree(mission, task) {
  const cwd = taskDir(mission, task);
  const branch = taskBranch(mission, task);
  if (fs.existsSync(cwd) && currentBranch(cwd) !== branch) {
    throw codedError('worktree-mismatch', { dir: cwd, actual: currentBranch(cwd), branch });
  }
}

// The task's branch starts from the integration branch. A worktree left by a failed launch is reused.
function prepareTask(mission, task) {
  const cwd = taskDir(mission, task);
  const branch = taskBranch(mission, task);
  checkTaskWorktree(mission, task);
  if (!fs.existsSync(cwd)) {
    if (branchExists(mission.dir, branch)) {
      git(mission.dir, ['worktree', 'add', cwd, branch]);
    } else {
      git(mission.dir, ['worktree', 'add', '-b', branch, cwd, mission.config.delivery.branch]);
    }
  }
  return { cwd, branch };
}

// 'new' (commits to merge), 'merged' (merged by an earlier, interrupted delivery) or 'empty' (no
// commit at all). A branch that never got a commit still points at a commit of the integration
// branch's own line (its first parents); a merged branch points at a commit reached through a merge.
function branchWork(mission, branch) {
  const integration = mission.config.delivery.branch;
  if (git(mission.dir, ['rev-list', '--count', `${integration}..${branch}`]) !== '0') return 'new';
  const tip = git(mission.dir, ['rev-parse', branch]);
  const ownLine = git(mission.dir, ['rev-list', '--first-parent', integration]).split('\n');
  return ownLine.includes(tip) ? 'empty' : 'merged';
}

// A stopped merge leaves MERGE_HEAD in the worktree's git folder.
function mergeInProgress(cwd) {
  return fs.existsSync(path.resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'MERGE_HEAD'])));
}

// Relaylead's own commits skip the project's hooks (--no-verify): they hold only the crew's
// already committed work and a state line.
function mergeTask(mission, task, branch) {
  const integration = integrationDir(mission);
  try {
    git(integration, ['merge', '--no-ff', '--no-edit', '--no-verify', branch]);
  } catch (err) {
    if (!mergeInProgress(integration)) throw err; // not a conflict, e.g. no git user configured
    git(integration, ['merge', '--abort']);
    throw codedError('merge-conflict', { id: task.id, branch });
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// On Windows, a folder that a process still uses as its working folder cannot be removed for a moment.
function removeWorktree(mission, cwd) {
  for (let attempt = 1; ; attempt++) {
    try {
      git(mission.dir, ['worktree', 'remove', '--force', cwd]);
      return;
    } catch (err) {
      if (process.platform !== 'win32' || attempt >= 5) throw err;
      sleep(200 * attempt);
    }
  }
}

// Merges a done task. Refuses work that is not committed or empty, which `worktree remove --force`
// would otherwise destroy. Returns the warnings of finish().
function deliver(mission, task) {
  const cwd = taskDir(mission, task);
  const branch = taskBranch(mission, task);
  checkTaskWorktree(mission, task);
  if (fs.existsSync(cwd) && git(cwd, ['status', '--porcelain']) !== '') {
    throw codedError('task-uncommitted', { id: task.id, dir: cwd });
  }
  if (!branchExists(mission.dir, branch)) throw codedError('task-branch-missing', { id: task.id, branch });
  const work = branchWork(mission, branch);
  if (work === 'empty') throw codedError('task-empty', { id: task.id, branch });
  if (work === 'new') mergeTask(mission, task, branch);

  tasksDirSource.markDone(integrationDir(mission), mission.config.source.dir, task.id);
  return finish(mission, task);
}

// The end of a delivery, also run again for a task already delivered: an interrupted delivery is
// finished. Commits the task's state line if needed, then removes its worktree and branch. The task
// is delivered once committed: a failed removal is returned as a warning, retried at the next deliver.
function finish(mission, task) {
  const integration = integrationDir(mission);
  const file = sourceFile(mission, task);
  if (git(integration, ['status', '--porcelain', '--', file]) !== '') {
    git(integration, ['commit', '--no-verify', '-m', `chore(relaylead): ${task.id} livrée`, '--', file]);
  }

  const cwd = taskDir(mission, task);
  const branch = taskBranch(mission, task);
  try {
    // A folder on another branch is not this task's worktree: it is left alone.
    if (fs.existsSync(cwd) && currentBranch(cwd) === branch) removeWorktree(mission, cwd);
    if (branchExists(mission.dir, branch)) git(mission.dir, ['branch', '-D', branch]);
  } catch (err) {
    return [codedError('cleanup-failed', { id: task.id, detail: err.message })];
  }
  return [];
}

module.exports = { prepareMission, prepareTask, deliver, finish };
