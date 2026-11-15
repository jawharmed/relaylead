// Delivery "branch merged locally". Each task gets its own branch and worktree; a finished task is
// merged into the integration branch, in the integration worktree. All merges and all writes to the
// task source happen there: the user's own checkout never changes.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { codedError } = require('../core/messages');
const tasksDirSource = require('../sources/tasks-dir');

// Git refuses to start when another git command holds a lock file (index.lock, a ref's .lock),
// for instance a crew member committing, or git's background maintenance. Its message names the
// file, in every language: "Unable to create '.../index.lock': File exists".
// On Windows, an antivirus or the search indexer may hold a file for a moment: git then fails
// with "unable to unlink", "Permission denied", "Device or resource busy", "Invalid argument" or
// "being used by another process". The same command a moment later works.
const LOCK_FILE = /\.lock['"]|unable to unlink|unable to create|permission denied|resource busy|invalid argument|used by another process/i;
const LOCK_ATTEMPTS = 10; // about 5 s in all

// Whether the message of a failed git command is worth trying again.
function isTransientGitError(detail) {
  return LOCK_FILE.test(detail);
}

// Writing a file, or renaming one over another, fails the same way on Windows for a moment.
function retryFileWrite(action) {
  for (let attempt = 1; ; attempt++) {
    try {
      return action();
    } catch (err) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code) || attempt >= LOCK_ATTEMPTS) throw err;
      sleep(100 * attempt);
    }
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Never through a shell: paths may contain spaces. Git's own output is kept for the error message.
// A command refused by a lock did nothing yet, so it is safe to run it again.
function git(cwd, args) {
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }).trim();
    } catch (err) {
      const detail = String(err.stderr || err.stdout || err.message).trim();
      if (isTransientGitError(detail) && attempt < LOCK_ATTEMPTS) {
        sleep(100 * attempt);
        continue;
      }
      throw new Error(`git ${args.join(' ')} failed: ${detail}`);
    }
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

// Whether `ref` holds the file or folder `file` (path from the repository root, with / separators).
function refHas(dir, ref, file) {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}:${file}`], { cwd: dir, stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false; // missing path, or a ref without commits
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

// The task folder and a task's file, with forward slashes, as git paths expect.
function sourceDir(mission) {
  return mission.config.source.dir.replace(/\\/g, '/');
}

function sourceFile(mission, task) {
  return `${sourceDir(mission)}/${task.id}.md`;
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

// Checks everything before changing anything. Then creates the integration branch from the user's
// current branch, with its worktree; or, when a former mission made them, brings the user's commits
// made since into the integration branch, so this mission sees its new tasks.
function prepareMission(mission) {
  const { branch } = mission.config.delivery;
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
  if (git(mission.dir, ['status', '--porcelain', '--', sourceDir(mission)]) !== '') {
    throw codedError('tasks-not-committed', { dir: sourceDir(mission), branch });
  }
  const integration = integrationDir(mission);
  if (fs.existsSync(integration) && currentBranch(integration) !== branch) {
    throw codedError('integration-mismatch', { dir: integration, actual: currentBranch(integration), branch });
  }
  const isNew = !branchExists(mission.dir, branch);
  if (isNew && !refHas(mission.dir, 'HEAD', sourceDir(mission))) {
    throw codedError('tasks-not-committed', { dir: sourceDir(mission), branch });
  }

  excludeRelaylead(mission.dir);
  // `git branch` does not check the branch out: the user's checkout stays as it is.
  if (isNew) git(mission.dir, ['branch', branch]);
  if (!fs.existsSync(integration)) git(mission.dir, ['worktree', 'add', integration, branch]);
  if (!isNew) {
    updateIntegration(mission);
    if (!refHas(mission.dir, branch, sourceDir(mission))) {
      throw codedError('tasks-not-committed', { dir: sourceDir(mission), branch });
    }
  }
}

// Merges the user's current commit into the integration branch, unless it is there already.
function updateIntegration(mission) {
  const { branch } = mission.config.delivery;
  const userCommit = git(mission.dir, ['rev-parse', 'HEAD']);
  if (git(mission.dir, ['rev-list', '--count', `${branch}..${userCommit}`]) === '0') return;
  const userBranch = currentBranch(mission.dir); // 'HEAD' when detached
  const message = `Merge ${userBranch === 'HEAD' ? userCommit : userBranch} into ${branch}`;
  if (!mergeOrAbort(integrationDir(mission), ['-m', message, userCommit])) {
    throw codedError('integration-sync-conflict', { branch, dir: integrationDir(mission) });
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

// Merges in the integration worktree; on a conflict, cancels the merge and returns false.
// Relaylead's own commits skip the project's hooks (--no-verify): they hold only work already
// committed and state lines.
// A merge that meets a held index.lock stops like a conflict ("Unable to write index"), but with no
// conflicted file: it is cancelled and tried again.
function mergeOrAbort(integration, args) {
  for (let attempt = 1; ; attempt++) {
    try {
      git(integration, ['merge', '--no-ff', '--no-edit', '--no-verify', ...args]);
      return true;
    } catch (err) {
      if (!mergeInProgress(integration)) throw err; // stopped before merging, e.g. no git user configured
      const conflicted = git(integration, ['diff', '--name-only', '--diff-filter=U']) !== '';
      git(integration, ['merge', '--abort']);
      if (conflicted) return false;
      if (attempt >= LOCK_ATTEMPTS) throw err;
      sleep(100 * attempt);
    }
  }
}

// On Windows, a folder cannot be removed while a process still uses it: a crew member that has
// just been stopped, or an antivirus scanning the new files. That lasts a moment, so retry for
// about 5 s ("Permission denied", "Directory not empty", "busy"). Removing again is harmless.
function removeWorktree(mission, cwd) {
  for (let attempt = 1; ; attempt++) {
    try {
      git(mission.dir, ['worktree', 'remove', '--force', cwd]);
      return;
    } catch (err) {
      if (process.platform !== 'win32' || attempt >= 7) throw err;
      sleep(200 * attempt);
    }
  }
}

// Refuses work that is not committed or empty: it could not be delivered, and `worktree remove
// --force` would destroy it. Run by `relaylead task done`, while the crew member can still fix it,
// and again by deliver. Returns branchWork(): 'new' or 'merged'.
function checkDone(mission, task) {
  const cwd = taskDir(mission, task);
  const branch = taskBranch(mission, task);
  checkTaskWorktree(mission, task);
  if (fs.existsSync(cwd) && git(cwd, ['status', '--porcelain']) !== '') {
    throw codedError('task-uncommitted', { id: task.id, dir: cwd });
  }
  if (!branchExists(mission.dir, branch)) throw codedError('task-branch-missing', { id: task.id, branch });
  const work = branchWork(mission, branch);
  if (work === 'empty') throw codedError('task-empty', { id: task.id, branch });
  return work;
}

// Merges a done task, once checkDone accepts its work. Returns the warnings of finish().
function deliver(mission, task) {
  const branch = taskBranch(mission, task);
  const work = checkDone(mission, task);
  if (work === 'new' && !mergeOrAbort(integrationDir(mission), [branch])) {
    throw codedError('merge-conflict', { id: task.id, branch });
  }

  retryFileWrite(() => tasksDirSource.markDone(integrationDir(mission), mission.config.source.dir, task.id));
  return finish(mission, task);
}

// Work done after the delivery, which removing the worktree and branch would lose.
function hasLateWork(mission, task) {
  const cwd = taskDir(mission, task);
  const branch = taskBranch(mission, task);
  if (fs.existsSync(cwd) && currentBranch(cwd) === branch && git(cwd, ['status', '--porcelain']) !== '') return true;
  if (!branchExists(mission.dir, branch)) return false;
  return git(mission.dir, ['rev-list', '--count', `${mission.config.delivery.branch}..${branch}`]) !== '0';
}

// The end of a delivery, also run again for a task already delivered: an interrupted delivery is
// finished. Commits the task's state line if needed, then removes its worktree and branch, unless
// they hold work done since. The task is delivered once committed: a failed or skipped removal is
// returned as a warning, and the next deliver tries again.
function finish(mission, task) {
  const integration = integrationDir(mission);
  const file = sourceFile(mission, task);
  const cwd = taskDir(mission, task);
  const branch = taskBranch(mission, task);
  // The work is merged by now: nothing from here on may fail the delivery. The state line stays
  // uncommitted if git keeps refusing, and the next deliver commits it.
  try {
    if (git(integration, ['status', '--porcelain', '--', file]) !== '') {
      git(integration, ['commit', '--no-verify', '-m', `chore(relaylead): ${task.id} livrée`, '--', file]);
    }
    if (hasLateWork(mission, task)) return [codedError('task-late-work', { id: task.id, branch, dir: cwd })];
    // A folder on another branch is not this task's worktree: it is left alone.
    if (fs.existsSync(cwd) && currentBranch(cwd) === branch) removeWorktree(mission, cwd);
    if (branchExists(mission.dir, branch)) git(mission.dir, ['branch', '-D', branch]);
  } catch (err) {
    return [codedError('cleanup-failed', { id: task.id, detail: err.message })];
  }
  return [];
}

module.exports = { prepareMission, prepareTask, checkDone, deliver, finish, isTransientGitError };
