// Delivery "branch merged locally". Each task gets its own branch and worktree; a finished task is
// merged into the integration branch, in the integration worktree. All merges and all writes to the
// task source happen there: the user's own checkout never changes.
const fs = require('node:fs');
const path = require('node:path');
const { t, codedError } = require('../core/messages');
const { sleepSync, retrySync } = require('../core/timing');
const { runFileSync, gitTimeoutMs } = require('../core/run-file');
const tasksDirSource = require('../sources/tasks-dir');
const layout = require('../core/layout');

// Git refuses to start when another git command holds a lock file (index.lock, a ref's .lock),
// for instance a crew member committing, or git's background maintenance. Its message names the
// file, in every language: "Unable to create '.../index.lock': File exists".
// On Windows, an antivirus or the search indexer may hold a file for a moment: git then fails
// with "unable to unlink", "Permission denied", "Device or resource busy", "Invalid argument" or
// "being used by another process". The same command a moment later works.
// A merge that meets a held index.lock stops with "Unable to write index", and leaves the merge going.
const LOCK_FILE =
  /\.lock['"]|unable to write index|unable to unlink|unable to create|permission denied|resource busy|invalid argument|used by another process/i;
const LOCK_ATTEMPTS = 10; // about 5 s in all
// After a commit or a merge, git may start a gc or maintenance in the background: it may keep the
// output pipes open, and it holds the repository's locks while relaylead works there.
const NO_BACKGROUND_MAINTENANCE = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];

// Whether the message of a failed git command is worth trying again.
function isTransientGitError(detail) {
  return LOCK_FILE.test(detail);
}

// Runs git, never through a shell (paths may contain spaces), and stops it after gitTimeoutMs().
// Returns as soon as git has ended, even when a process it started keeps its output open.
// LC_ALL=C: git speaks English whatever the system's language, so its messages can be read (the
// user's hooks run with it too).
function runGit(cwd, args, stdio) {
  try {
    return runFileSync('git', [...NO_BACKGROUND_MAINTENANCE, ...args], {
      cwd,
      env: { ...process.env, LC_ALL: 'C' },
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
      throw Object.assign(new Error(`git ${args.join(' ')} failed: ${detail}`), { output: detail });
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

// The folders of core/layout.js: per mission since 0.2, shared by the missions of 0.1.
function integrationDir(mission) {
  return layout.integrationDir(mission);
}

function taskDir(mission, task) {
  return layout.taskDir(mission, task.id);
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
  // A versioned memory must stay visible to git: memory.js writes the rules that leave it out of the exclusion.
  const memory = require('../core/memory'); // lazy: memory.js and the missions need this file first
  const settings = memory.memorySettings(dir);
  if (settings.enabled && settings.versioned) return memory.updateExclude(dir, true);
  const commonDir = path.resolve(dir, git(dir, ['rev-parse', '--git-common-dir']));
  const file = path.join(commonDir, 'info', 'exclude');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (text.split(/\r?\n/).includes('.relaylead/')) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const separator = text === '' || text.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(file, `${separator}.relaylead/\n`);
}

// Checks everything before changing anything. Then creates the integration branch from the user's
// current branch, with its worktree; or, when a former mission made them, brings the user's commits
// made since into the integration branch, so this mission sees its new tasks.
// Returns the warnings for the user (oldIntegrationWarnings).
function prepareMission(mission) {
  const { branch } = mission.config.delivery;
  if (mission.config.guard.protectedBranches.includes(branch)) {
    throw codedError('protected-branch', { branch });
  }
  if (!fs.existsSync(path.join(mission.dir, '.git'))) {
    throw codedError('not-a-git-repo', { dir: mission.dir });
  }
  // The crew members work from commits: uncommitted tasks would not reach them. Tasks of another
  // source (GitHub issues) are not files in the repository: there is nothing to check.
  const tasksInRepo = mission.config.source.type === 'tasks-dir';
  if (tasksInRepo && git(mission.dir, ['status', '--porcelain', '--', sourceDir(mission)]) !== '') {
    throw codedError('tasks-not-committed', { dir: sourceDir(mission), branch });
  }
  // A worktree of 0.1 left in .relaylead/worktrees/<id>, where <id> is this mission's name: this
  // mission's worktrees would go inside it, and removing it would remove them too.
  const ownFolder = layout.worktreesDir(mission);
  if (layout.isPerMission(mission) && fs.existsSync(path.join(ownFolder, '.git'))) {
    throw codedError('worktrees-dir-taken', { dir: ownFolder, mission: mission.name });
  }
  const integration = integrationDir(mission);
  if (fs.existsSync(integration)) {
    const actual = gitInIntegration(mission, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (actual !== branch) throw codedError('integration-mismatch', { dir: integration, actual, branch });
  }
  const isNew = !branchExists(mission.dir, branch);
  if (tasksInRepo && isNew && !refHas(mission.dir, 'HEAD', sourceDir(mission))) {
    throw codedError('tasks-not-committed', { dir: sourceDir(mission), branch });
  }
  if (fs.existsSync(integration)) {
    commitPendingStateLines(mission);
    checkIntegrationClean(mission);
  }

  excludeRelaylead(mission.dir);
  // `git branch` does not check the branch out: the user's checkout stays as it is.
  if (isNew) git(mission.dir, ['branch', branch]);
  if (!fs.existsSync(integration)) git(mission.dir, ['worktree', 'add', integration, branch]);
  if (!isNew) {
    updateIntegration(mission);
    if (tasksInRepo && !refHas(mission.dir, branch, sourceDir(mission))) {
      throw codedError('tasks-not-committed', { dir: sourceDir(mission), branch });
    }
  }
  return oldIntegrationWarnings(mission);
}

// The integration branch of relaylead 0.1, shared by the missions of then. Since 0.2, a mission starts
// from the user's branch: work delivered on relaylead/integration and not merged into it is not seen,
// and its tasks would be done again. Not a refusal: the user may have left that work on purpose.
const OLD_INTEGRATION_BRANCH = 'relaylead/integration';

function oldIntegrationWarnings(mission) {
  if (!layout.isPerMission(mission) || !branchExists(mission.dir, OLD_INTEGRATION_BRANCH)) return [];
  const count = git(mission.dir, ['rev-list', '--count', `HEAD..refs/heads/${OLD_INTEGRATION_BRANCH}`]);
  if (count === '0') return [];
  return [codedError('old-integration-unmerged', { branch: OLD_INTEGRATION_BRANCH, count })];
}

// A state line that a delivery left uncommitted in the integration worktree, on purpose (a hook
// refused its commit, or the commit did not end in time), is committed now, as finish() does.
// Only the task files (<source.dir>/<id>.md) that were changed count: anything else is left to
// checkIntegrationClean.
function commitPendingStateLines(mission) {
  const hooks = runHooks(mission);
  const changed = gitInIntegration(mission, ['diff', '--name-only', '-z', '--diff-filter=M', 'HEAD', '--', sourceDir(mission)]);
  for (const file of changed.split('\0').filter(Boolean)) {
    const id = path.posix.basename(file, '.md');
    if (file !== sourceFile(mission, { id })) continue;
    try {
      commitStateLine(mission, id, hooks);
    } catch (err) {
      if (!hooks || err.timedOut) throw err;
      throw codedError('launch-state-line-hook-failed', { id, output: shownOutput(err.output || err.message) });
    }
  }
}

// Changes nobody committed in the integration worktree would get in the way of the merges, with a
// raw git error, or be mixed into relaylead's commits.
function checkIntegrationClean(mission) {
  const status = gitInIntegration(mission, ['status', '--porcelain', '--untracked-files=all']);
  if (status === '') return;
  // Each line is "XY path": the status letters, then the path.
  const files = status.split(/\r?\n/).map((line) => line.trim().replace(/^\S+\s+/, ''));
  throw codedError('integration-dirty', { dir: integrationDir(mission), files: files.join(', '), tasksDir: sourceDir(mission) });
}

// Merges the user's current commit into the integration branch, unless it is there already.
function updateIntegration(mission) {
  const { branch } = mission.config.delivery;
  const refusal = { code: 'launch-hook-failed', vars: { what: 'integration update', branch } };
  const userCommit = git(mission.dir, ['rev-parse', 'HEAD']);
  if (git(mission.dir, ['rev-list', '--count', `${branch}..${userCommit}`]) === '0') return;
  const userBranch = currentBranch(mission.dir); // 'HEAD' when detached
  const message = `Merge ${userBranch === 'HEAD' ? userCommit : userBranch} into ${branch}`;
  if (!mergeOrAbort(mission, ['-m', message, userCommit], { runHooks: runHooks(mission), refusal })) {
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

// A stopped merge leaves MERGE_HEAD in the worktree's git folder. Runs git directly, not through
// gitInIntegration: the cleanup of a killed git uses it, and must not clean up after itself.
function mergeInProgress(cwd) {
  return fs.existsSync(path.resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'MERGE_HEAD'])));
}

// Runs git in the integration worktree. A command stopped by its timeout was killed: it may have
// left its index.lock, and a merge going. Only one relaylead at a time runs git there (a launch or a
// delivery holds the mission's start.lock), and the killed git has ended, so
// that index.lock is stale: it is removed and the merge cancelled before the error is thrown.
function gitInIntegration(mission, args) {
  try {
    return git(integrationDir(mission), args);
  } catch (err) {
    if (err.timedOut) throw cleanUpKilledGit(integrationDir(mission), err);
    throw err;
  }
}

// Best effort: returns the error to throw, saying what was done. Runs git directly: a cleanup that
// does not end in turn is not cleaned up again.
function cleanUpKilledGit(integration, err) {
  try {
    const indexLock = path.resolve(integration, git(integration, ['rev-parse', '--git-path', 'index.lock']));
    fs.rmSync(indexLock, { force: true });
    if (mergeInProgress(integration)) {
      git(integration, ['merge', '--abort']);
      err.message += '; the merge was cancelled';
    }
  } catch (cleanup) {
    err.message += `; it could not be cancelled (${cleanup.message}): check the integration worktree ${integration}`;
  }
  return err;
}

// Whether relaylead's own commits run the project's git hooks. A mission launched before this setting
// existed runs them.
function runHooks(mission) {
  return mission.config.delivery.runHooks !== false;
}

// What a hook (and git) printed is shown in the error, cut so that a long lint report stays readable.
// Its last period is dropped: the message goes on with its own sentence.
const MAX_OUTPUT = 2000;

function shownOutput(text) {
  return String(text).trim().slice(0, MAX_OUTPUT).replace(/\.+$/, '');
}

// `merge --abort` fails when a hook changed a merged file ("Entry 'a.txt' not uptodate"). With no
// changes of its own before the merge, the worktree goes back to its last commit: that drops only
// what the merge and the hook wrote (files the hook created stay). Changes made before the merge, such
// as a state line not committed yet, would be lost too: the worktree is then left to the user.
function cancelMerge(mission, changedBefore) {
  try {
    gitInIntegration(mission, ['merge', '--abort']);
  } catch (err) {
    if (err.timedOut) throw err;
    if (changedBefore) {
      throw codedError('integration-stuck', { dir: integrationDir(mission), output: shownOutput(err.output || err.message) });
    }
    gitInIntegration(mission, ['reset', '--hard', 'HEAD']);
  }
}

// Merges in the integration worktree; on a conflict, cancels the merge and returns false. Runs the
// project's hooks unless runHooks is false (--no-verify).
// Any other failure is cancelled too. A held lock ("Unable to write index", with no conflicted file)
// is tried again, LOCK_ATTEMPTS times at most. Otherwise, when the hooks run, a hook may be the cause:
// throws refusal.code with refusal.vars and git's output; without hooks, throws git's own error.
// git() is not used for the merge: its own retries would meet the merge left going.
function mergeOrAbort(mission, args, { runHooks: hooks, refusal }) {
  const integration = integrationDir(mission);
  const verify = hooks ? [] : ['--no-verify'];
  const changedBefore = gitInIntegration(mission, ['status', '--porcelain', '--untracked-files=no']) !== '';
  for (let attempt = 1; ; attempt++) {
    try {
      runGit(integration, ['merge', '--no-ff', '--no-edit', ...verify, ...args], ['ignore', 'pipe', 'pipe']);
      return true;
    } catch (err) {
      if (err.timedOut) throw cleanUpKilledGit(integration, err);
      const output = `${err.stdout || ''}${err.stderr || ''}`.trim() || err.message;
      if (mergeInProgress(integration)) {
        const conflicted = gitInIntegration(mission, ['diff', '--name-only', '--diff-filter=U']) !== '';
        cancelMerge(mission, changedBefore);
        if (conflicted) return false;
      }
      if (isTransientGitError(output) && attempt < LOCK_ATTEMPTS) {
        sleepSync(100 * attempt);
        continue;
      }
      if (hooks) throw codedError(refusal.code, { ...refusal.vars, output: shownOutput(output) });
      throw new Error(`git merge ${args.join(' ')} failed: ${output}`);
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
// runHooks, when given, replaces the mission's delivery.runHooks (the user's --no-hooks).
function deliver(mission, task, { runHooks: hooks = runHooks(mission) } = {}) {
  const branch = taskBranch(mission, task);
  const work = checkDone(mission, task);
  const refusal = { code: 'hook-failed', vars: { what: 'merge', id: task.id, branch, mission: mission.name } };
  if (work === 'new' && !mergeOrAbort(mission, [branch], { runHooks: hooks, refusal })) {
    throw codedError('merge-conflict', { id: task.id, branch });
  }

  // The branch is merged now: the next deliver finds it 'merged' and writes the line again.
  try {
    tasksDirSource.markDone(integrationDir(mission), mission.config.source.dir, task.id);
  } catch (err) {
    throw codedError('mark-failed', { id: task.id, detail: err.message });
  }
  return finish(mission, task, { runHooks: hooks });
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
function finish(mission, task, { runHooks: hooks = runHooks(mission) } = {}) {
  const file = sourceFile(mission, task);
  const cwd = taskDir(mission, task);
  const branch = taskBranch(mission, task);
  // The work is merged by now: nothing from here on may fail the delivery. The state line stays
  // uncommitted if git or a hook keeps refusing, and the next deliver commits it.
  try {
    if (gitInIntegration(mission, ['status', '--porcelain', '--', file]) !== '') commitStateLine(mission, task.id, hooks);
  } catch (err) {
    if (hooks && !err.timedOut) {
      const output = shownOutput(err.output || err.message);
      return [codedError('state-line-hook-failed', { what: 'state line commit', id: task.id, output })];
    }
    return [codedError('cleanup-failed', { id: task.id, detail: err.message })];
  }
  try {
    if (hasLateWork(mission, task)) return [codedError('task-late-work', { id: task.id, branch, dir: cwd })];
    // A folder on another branch is not this task's worktree: it is left alone.
    if (fs.existsSync(cwd) && currentBranch(cwd) === branch) removeWorktree(mission, cwd);
    if (branchExists(mission.dir, branch)) git(mission.dir, ['branch', '-D', branch]);
  } catch (err) {
    return [codedError('cleanup-failed', { id: task.id, detail: err.message })];
  }
  return [];
}

// Commits only the state line of task `id`, written by markDone in the integration worktree.
function commitStateLine(mission, id, hooks) {
  const message = t('deliveryCommit', { id }, mission.config.language);
  gitInIntegration(mission, ['commit', ...(hooks ? [] : ['--no-verify']), '-m', message, '--', sourceFile(mission, { id })]);
}

// The task worktrees of the mission, as git lists them: those on a branch relaylead/<mission>/….
// `locked` is true for a worktree locked with `git worktree lock`. The user's own checkout, the
// integration worktree and the worktrees of other missions are left out; so is any worktree on the
// integration branch, wherever it is: since 0.2, that branch is relaylead/<mission>/integration.
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
  const integrationBranch = mission.config.delivery.branch;
  return worktrees.filter(
    (worktree) => worktree.branch && worktree.branch !== integrationBranch && realPath(worktree.dir) !== checkout,
  );
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
  excludeRelaylead,
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
  // For deliveries/github-pr.js, which works on the same branches and worktrees.
  integrationDir,
  taskBranch,
  git,
  removeWorktree,
  branchExists,
};
