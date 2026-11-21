// Delivery "GitHub pull request". Branches and worktrees are those of local-merge: each task works on
// its own branch, from the integration branch. A finished task's branch is pushed, a pull request
// to the integration branch is opened and merged on GitHub, the local integration branch follows the
// remote one, then the task's issue is closed. Meant for the source github-issues.
const localMerge = require('./local-merge');
const { gh, checkGh } = require('../core/github');
const githubIssues = require('../sources/github-issues');
const { codedError } = require('../core/messages');

function remoteName(mission) {
  return mission.config.delivery.remote || 'origin';
}

// gh takes the repository of the user's checkout, unless the source names one.
function ghIn(mission, args) {
  const { repo } = mission.config.source;
  return gh([...args, ...(repo ? ['--repo', repo] : [])], { cwd: mission.dir });
}

function push(mission, branch, options = []) {
  try {
    localMerge.git(mission.dir, ['push', ...options, remoteName(mission), branch]);
  } catch (err) {
    throw codedError('push-failed', { branch, remote: remoteName(mission), detail: err.output || err.message });
  }
}

// gh must work before anything is made. The pull requests need the integration branch on GitHub.
function prepareMission(mission) {
  checkGh({ cwd: mission.dir });
  localMerge.prepareMission(mission);
  push(mission, mission.config.delivery.branch);
}

// The pull request of the task's branch, merged by an earlier delivery or open; null when none.
function findPr(mission, branch) {
  const prs = JSON.parse(ghIn(mission, ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,url']));
  return prs.find((pr) => pr.state === 'MERGED') || prs.find((pr) => pr.state === 'OPEN') || null;
}

function openPr(mission, task, branch) {
  const body = `Closes #${githubIssues.issueNumber(task.id)}\n\n${task.summary || ''}`.trim();
  // gh prints the address of the new pull request, which ends with its number.
  const output = ghIn(mission, ['pr', 'create', '--base', mission.config.delivery.branch, '--head', branch, '--title', task.title, '--body', body]);
  const url = output.split('\n').pop().trim();
  return { number: Number(url.split('/').pop()), state: 'OPEN', url };
}

// No review is waited for: the pull request is opened and merged in the same delivery. A review
// that requested changes on an earlier pull request of the branch (a delivery played again) still
// refuses the delivery; an approval is never needed.
function checkReview(mission, task, pr) {
  const { reviewDecision } = JSON.parse(ghIn(mission, ['pr', 'view', String(pr.number), '--json', 'reviewDecision,state']));
  if (reviewDecision === 'CHANGES_REQUESTED') throw codedError('pr-changes-requested', { id: task.id, url: pr.url });
}

// No --delete-branch: finish() removes the task's branch, here and on its worktree.
function mergePr(mission, task, pr) {
  try {
    ghIn(mission, ['pr', 'merge', String(pr.number), '--merge']);
  } catch (err) {
    if (err.code === 'gh-failed' && /not mergeable|conflict/i.test(err.vars.detail)) {
      throw codedError('pr-merge-conflict', { id: task.id, url: pr.url });
    }
    throw err;
  }
}

// The local integration branch takes the merge made on GitHub. Nothing else commits on it, so it
// only moves forward.
function followRemote(mission) {
  const integration = localMerge.integrationDir(mission);
  const remote = remoteName(mission);
  localMerge.git(integration, ['fetch', remote]);
  localMerge.git(integration, ['merge', '--ff-only', `${remote}/${mission.config.delivery.branch}`]);
}

// Delivers a done task. Played again after a failure, a pull request already merged is not pushed,
// opened or merged again: the delivery goes on from where it stopped. Returns the address of the
// pull request as a first warning, then those of finish().
function deliver(mission, task, { runHooks } = {}) {
  const branch = localMerge.taskBranch(mission, task);
  localMerge.checkDone(mission, task);
  let pr = findPr(mission, branch);
  if (!pr || pr.state !== 'MERGED') {
    push(mission, branch, ['--force-with-lease']);
    if (!pr) pr = openPr(mission, task, branch);
    checkReview(mission, task, pr);
    mergePr(mission, task, pr);
  }
  followRemote(mission);
  githubIssues.markDone(mission.config.source, task.id, { cwd: mission.dir });
  return [codedError('pr-merged', { id: task.id, url: pr.url }), ...finish(mission, task, { runHooks })];
}

// The end of a delivery, also run for a task already delivered: removes the task's worktree and
// branch, unless they hold work done since. local-merge's own: its state line commit finds no task
// file here, and does nothing.
function finish(mission, task, options) {
  return localMerge.finish(mission, task, options);
}

module.exports = {
  prepareMission,
  prepareTask: localMerge.prepareTask,
  checkDone: localMerge.checkDone,
  deliver,
  finish,
  missionWorktrees: localMerge.missionWorktrees,
  cleanMission: localMerge.cleanMission,
  missionBranches: localMerge.missionBranches,
  removeMission: localMerge.removeMission,
};
