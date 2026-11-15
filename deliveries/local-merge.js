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

function branchExists(dir, branch) {
  return git(dir, ['branch', '--list', branch]) !== '';
}

function worktreesDir(mission) {
  return path.join(mission.dir, '.relaylead', 'worktrees');
}

function integrationDir(mission) {
  return path.join(worktreesDir(mission), '_integration');
}

function taskBranch(mission, task) {
  return `relaylead/${mission.name}/${task.id}`;
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

// Creates the integration branch from the current branch, and its worktree. A later mission on the
// same folder reuses them.
function prepareMission(mission) {
  const { branch } = mission.config.delivery;
  if (mission.config.guard.protectedBranches.includes(branch)) {
    throw codedError('protected-branch', { branch });
  }
  if (!fs.existsSync(path.join(mission.dir, '.git'))) {
    throw codedError('not-a-git-repo', { dir: mission.dir });
  }
  excludeRelaylead(mission.dir);
  if (fs.existsSync(integrationDir(mission))) return;
  // `git branch` does not check the branch out: the user's checkout stays as it is.
  if (!branchExists(mission.dir, branch)) git(mission.dir, ['branch', branch]);
  git(mission.dir, ['worktree', 'add', integrationDir(mission), branch]);
}

// The task's branch starts from the integration branch. A worktree left by a failed launch is reused.
function prepareTask(mission, task) {
  const cwd = path.join(worktreesDir(mission), task.id);
  const branch = taskBranch(mission, task);
  if (!fs.existsSync(cwd)) {
    if (branchExists(mission.dir, branch)) {
      git(mission.dir, ['worktree', 'add', cwd, branch]);
    } else {
      git(mission.dir, ['worktree', 'add', '-b', branch, cwd, mission.config.delivery.branch]);
    }
  }
  return { cwd, branch };
}

// A stopped merge leaves MERGE_HEAD in the worktree's git folder.
function mergeInProgress(cwd) {
  return fs.existsSync(path.resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'MERGE_HEAD'])));
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

// Each step can be replayed after a crash: an already merged branch merges as "already up to date",
// and a worktree or branch already removed is skipped.
function deliver(mission, task) {
  const integration = integrationDir(mission);
  const branch = taskBranch(mission, task);
  if (branchExists(mission.dir, branch)) {
    try {
      git(integration, ['merge', '--no-ff', '--no-edit', branch]);
    } catch (err) {
      if (!mergeInProgress(integration)) throw err; // not a conflict, e.g. no git user configured
      git(integration, ['merge', '--abort']);
      throw codedError('merge-conflict', { id: task.id, branch });
    }
  }

  tasksDirSource.markDone(integration, mission.config.source.dir, task.id);
  if (git(integration, ['status', '--porcelain']) !== '') {
    git(integration, ['commit', '-a', '-m', `chore(relaylead): ${task.id} livrée`]);
  }

  const cwd = path.join(worktreesDir(mission), task.id);
  if (fs.existsSync(cwd)) removeWorktree(mission, cwd);
  if (branchExists(mission.dir, branch)) git(mission.dir, ['branch', '-D', branch]);
}

module.exports = { prepareMission, prepareTask, deliver };
