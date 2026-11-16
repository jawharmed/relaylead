// Delivery "branch merged locally". Each task gets its own branch and worktree; a finished task is
// merged into the integration branch, in the integration worktree. All merges and all writes to the
// task source happen there: the user's own checkout never changes.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { t, codedError } = require('../core/messages');
const { sleepSync, retrySync } = require('../core/timing');
const tasksDirSource = require('../sources/tasks-dir');

// Git refuses to start when another git command holds a lock file (index.lock, a ref's .lock),
// for instance a crew member committing, or git's background maintenance. Its message names the
// file, in every language: "Unable to create '.../index.lock': File exists".
// On Windows, an antivirus or the search indexer may hold a file for a moment: git then fails
// with "unable to unlink", "Permission denied", "Device or resource busy", "Invalid argument" or
// "being used by another process". The same command a moment later works.
const LOCK_FILE = /\.lock['"]|unable to unlink|unable to create|permission denied|resource busy|invalid argument|used by another process/i;
const LOCK_ATTEMPTS = 10; // about 5 s in all
// A git command that does not end in this time is stopped and fails. Without a bound, a git that
// hangs, or that leaves a process holding its output open, would block relaylead forever, and with
// it the start lock that every start and delivery of the mission waits for. Tests shorten it.
const gitTimeoutMs = () => Number(process.env.RELAYLEAD_GIT_TIMEOUT_MS) || 5 * 60 * 1000;
// After a commit or a merge, git may start a gc or maintenance in the background: it may keep the
// output pipes open, and it holds the repository's locks while relaylead works there.
const NO_BACKGROUND_MAINTENANCE = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];

// Whether the message of a failed git command is worth trying again.
function isTransientGitError(detail) {
  return LOCK_FILE.test(detail);
}

// Runs git, never through a shell (paths may contain spaces), and stops it after gitTimeoutMs().
function runGit(cwd, args, stdio) {
  try {
    return execFileSync('git', [...NO_BACKGROUND_MAINTENANCE, ...args], {
      cwd,
      encoding: 'utf8',
      stdio,
      windowsHide: true,
      timeout: gitTimeoutMs(),
      killSignal: 'SIGKILL',
    });
  } catch (err) {
    if (err.code === 'ETIMEDOUT') {
      const seconds = Math.round(gitTimeoutMs() / 1000);
      throw Object.assign(new Error(`git ${args.join(' ')} did not end within ${seconds} s`), { timedOut: true });
    }
    throw err;
  }
}

// Git's own output is kept for the error message.
// A command refused by a lock did nothing yet, so it is safe to run it again.
function git(cwd, args) {
  for (let attempt = 1; ; attempt++) {
    try {
      return runGit(cwd, args, ['ignore', 'pipe', 'pipe']).trim();
    } catch (err) {
      if (err.timedOut) throw err;
      const detail = String(err.stderr || err.stdout || err.message).trim();
      if (isTransientGitError(detail) && attempt < LOCK_ATTEMPTS) {
        sleepSync(100 * attempt);
        continue;
      }
      throw new Error(`git ${args.join(' ')} failed: ${detail}`);
    }
  }
}

// show-ref exits with 1 when the branch does not exist. Unlike `git branch --list`, it reads no pattern.
function branchExists(dir, branch) {
  try {
    runGit(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], 'ignore');
    return true;
  } catch (err) {
    if (err.status === 1) return false;
    throw err;
  }
}

// Whether `ref` holds the file or folder `file` (path from the repository root, with / separators).
function refHas(dir, ref, file) {
  try {
    runGit(dir, ['cat-file', '-e', `${ref}:${file}`], 'ignore');
    return true;
  } catch (err) {
    if (err.timedOut) throw err;
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
// When that mission is another Relaylead one (branch relaylead/<mission>/<id>), the error says to
// remove it.
function checkTaskWorktree(mission, task) {
  const cwd = taskDir(mission, task);
  const branch = taskBranch(mission, task);
  if (!fs.existsSync(cwd)) return;
  const actual = currentBranch(cwd);
  if (actual === branch) return;
  const err = codedError('worktree-mismatch', { dir: cwd, actual, branch });
  const owner = actual.match(/^relaylead\/([a-z0-9-]+)\/[^/]+$/);
  err.suffix = owner && owner[1] !== mission.name
    ? { key: 'worktree-of-mission', vars: { mission: owner[1], dir: cwd } }
    : { key: 'worktree-not-relaylead', vars: { dir: cwd } };
  err.message += t(err.suffix.key, err.suffix.vars);
  throw err;
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

// A merge stopped by its timeout was killed: it may have left the merge going and its index.lock.
// Only the holder of start.lock runs git in the integration worktree, and the killed git has ended,
// so that index.lock is stale. Best effort: returns the error to throw, saying what was done.
function cancelKilledMerge(integration, err) {
  try {
    const indexLock = path.resolve(integration, git(integration, ['rev-parse', '--git-path', 'index.lock']));
    fs.rmSync(indexLock, { force: true });
    if (mergeInProgress(integration)) git(integration, ['merge', '--abort']);
    err.message += '; the merge was cancelled';
  } catch (cleanup) {
    err.message += `; it could not be cancelled (${cleanup.message}): check the integration worktree ${integration}`;
  }
  return err;
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
      if (err.timedOut) throw cancelKilledMerge(integration, err);
      if (!mergeInProgress(integration)) throw err; // stopped before merging, e.g. no git user configured
      const conflicted = git(integration, ['diff', '--name-only', '--diff-filter=U']) !== '';
      git(integration, ['merge', '--abort']);
      if (conflicted) return false;
      if (attempt >= LOCK_ATTEMPTS) throw err;
      sleepSync(100 * attempt);
    }
  }
}

// On Windows, a folder cannot be removed while a process still uses it: a crew member that has
// just been stopped, or an antivirus scanning the new files. That lasts a moment, so retry for
// about 5 s ("Permission denied", "Directory not empty", "busy"). Removing again is harmless.
// A worktree locked with `git worktree lock` is removed only when `locked` says so (a second --force).
function removeWorktree(mission, cwd, { locked = false } = {}) {
  const force = locked ? ['--force', '--force'] : ['--force'];
  retrySync(() => git(mission.dir, ['worktree', 'remove', ...force, cwd]), {
    retryIf: () => process.platform === 'win32',
    budgetMs: 5000,
    delayMs: (attempt) => 200 * attempt,
  });
}

// Refuses work that is not committed (new files included, whatever status.showUntrackedFiles says)
// or empty: it could not be delivered, and `worktree remove --force` would destroy it. Run by
// `relaylead task done`, while the crew member can still fix it, and again by deliver.
// Returns branchWork(): 'new' or 'merged'.
function checkDone(mission, task) {
  const cwd = taskDir(mission, task);
  const branch = taskBranch(mission, task);
  checkTaskWorktree(mission, task);
  if (fs.existsSync(cwd) && git(cwd, ['status', '--porcelain', '--untracked-files=all']) !== '') {
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

  tasksDirSource.markDone(integrationDir(mission), mission.config.source.dir, task.id);
  return finish(mission, task);
}

// Work done after the delivery, which removing the worktree and branch would lose.
function hasLateWork(mission, task) {
  const cwd = taskDir(mission, task);
  const branch = taskBranch(mission, task);
  // --untracked-files=all: a user setting status.showUntrackedFiles=no would hide new files.
  if (fs.existsSync(cwd) && currentBranch(cwd) === branch) {
    if (git(cwd, ['status', '--porcelain', '--untracked-files=all']) !== '') return true;
  }
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

// The task worktrees of the mission, as git lists them: those on a branch relaylead/<mission>/….
// `locked` is true for a worktree locked with `git worktree lock`. The user's own checkout, the
// integration worktree and the worktrees of other missions are left out.
function missionWorktrees(mission) {
  const prefix = `refs/heads/relaylead/${mission.name}/`;
  const checkout = realPath(mission.dir);
  const worktrees = [];
  let current = null;
  // One block per worktree: "worktree <dir>", then "branch <ref>", "locked" and others.
  for (const line of git(mission.dir, ['worktree', 'list', '--porcelain']).split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { dir: path.resolve(line.slice('worktree '.length)), branch: null, locked: false };
      worktrees.push(current);
    }
    if (current && line.startsWith('branch ' + prefix)) current.branch = line.slice('branch refs/heads/'.length);
    if (current && (line === 'locked' || line.startsWith('locked '))) current.locked = true;
  }
  return worktrees.filter((worktree) => worktree.branch && realPath(worktree.dir) !== checkout);
}

// Git and the session registry may spell one folder differently: slashes, letter case, /private on macOS.
function realPath(dir) {
  try {
    return fs.realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

// At the stop or the end of a mission: removes its clean task worktrees, ignored files included
// (node_modules, build output). Their branches stay, so no commit is lost. A worktree where a
// session may still run (keepDirs), or with changes not committed, is kept and reported. Never
// throws: each problem is returned as a warning, and the next `relaylead stop` tries again.
function cleanMission(mission, { keepDirs = [] } = {}) {
  const warnings = [];
  let worktrees;
  try {
    worktrees = missionWorktrees(mission);
  } catch (err) {
    return [codedError('mission-cleanup-failed', { mission: mission.name, detail: err.message })];
  }
  const busy = keepDirs.map(realPath);
  const integration = realPath(integrationDir(mission));
  for (const { dir, branch } of worktrees) {
    if (!fs.existsSync(dir)) continue; // a folder removed by hand: `worktree prune` forgets it
    if (realPath(dir) === integration) continue; // the delivered work: never removed, whatever its branch
    const vars = { mission: mission.name, dir, branch };
    try {
      if (busy.includes(realPath(dir))) warnings.push(codedError('worktree-busy', vars));
      // --untracked-files=all: a user setting status.showUntrackedFiles=no would hide new files.
      else if (git(dir, ['status', '--porcelain', '--untracked-files=all']) !== '') {
        warnings.push(codedError('worktree-kept', vars));
      }
      else removeWorktree(mission, dir);
    } catch (err) {
      warnings.push(codedError('mission-cleanup-failed', { mission: mission.name, detail: err.message }));
    }
  }
  try {
    git(mission.dir, ['worktree', 'prune']);
  } catch (err) {
    warnings.push(codedError('mission-cleanup-failed', { mission: mission.name, detail: err.message }));
  }
  return warnings;
}

// The task branches of the mission: relaylead/<mission>/<id>. Full ref names, stripped by hand:
// %(refname:short) may add "heads/" when a tag has the same name.
function missionBranches(mission) {
  const output = git(mission.dir, ['for-each-ref', '--format=%(refname)', `refs/heads/relaylead/${mission.name}/`]);
  return output === '' ? [] : output.split(/\r?\n/).map((ref) => ref.slice('refs/heads/'.length));
}

// `relaylead remove`: removes the task worktrees and branches of the mission, ignored files
// included. The integration worktree and branch stay: they hold the delivered work. Checks
// everything before changing anything:
// - the user's checkout on a task branch is always refused: git cannot delete that branch;
// - unless `force`, so is work not delivered: a worktree with changes not committed or locked
//   (`git worktree lock`), a branch with commits the integration branch does not have (every branch,
//   when the integration branch is gone).
// Calls onBranchDeleted("<name> <sha>") as soon as each branch is deleted, so the sha is shown even
// if a later step fails: `git branch <name> <sha>` makes it again. Returns all of them.
function removeMission(mission, { force = false, onBranchDeleted = () => {} } = {}) {
  const integrationBranch = mission.config.delivery.branch;
  const integration = realPath(integrationDir(mission));
  const branches = missionBranches(mission).filter((branch) => branch !== integrationBranch);
  const checkoutBranch = currentBranch(mission.dir);
  if (branches.includes(checkoutBranch)) {
    throw codedError('checkout-on-task-branch', { dir: mission.dir, branch: checkoutBranch });
  }
  // A folder removed by hand has no work left: `worktree prune` forgets it.
  const worktrees = missionWorktrees(mission).filter(({ dir }) => fs.existsSync(dir) && realPath(dir) !== integration);
  // --untracked-files=all: a user setting status.showUntrackedFiles=no would hide new files.
  const dirty = worktrees
    .filter(({ dir, locked }) => locked || git(dir, ['status', '--porcelain', '--untracked-files=all']) !== '')
    .map(({ dir }) => dir);
  const integrationExists = branchExists(mission.dir, integrationBranch);
  const unmerged = branches.filter(
    (branch) =>
      !integrationExists ||
      git(mission.dir, ['rev-list', '--count', `refs/heads/${integrationBranch}..refs/heads/${branch}`]) !== '0',
  );
  const items = [...dirty, ...unmerged];
  if (items.length > 0 && !force) {
    throw codedError('remove-unmerged-work', { mission: mission.name, items: items.join(', ') });
  }

  const deleted = branches.map((branch) => `${branch} ${git(mission.dir, ['rev-parse', `refs/heads/${branch}`])}`);
  for (const { dir, locked } of worktrees) removeWorktree(mission, dir, { locked });
  // Before the branches: git refuses to delete a branch that a worktree, even a missing one, has out.
  git(mission.dir, ['worktree', 'prune']);
  branches.forEach((branch, index) => {
    git(mission.dir, ['branch', '-D', branch]);
    onBranchDeleted(deleted[index]);
  });
  return deleted;
}

module.exports = {
  prepareMission,
  prepareTask,
  checkDone,
  deliver,
  finish,
  missionWorktrees,
  cleanMission,
  missionBranches,
  removeMission,
  isTransientGitError,
  gitTimeoutMs,
};
