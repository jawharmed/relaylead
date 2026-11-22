// Where the branches and worktrees of a mission live in its project.
// A mission launched since 0.2 has `format: 2` in its mission.json: its own integration branch
// relaylead/<mission>/integration, and its worktrees under .relaylead/worktrees/<mission>/, so several
// missions can share a repository. A mission without it was launched by 0.1, and keeps the names of
// then until it ends: the branch of its config (relaylead/integration) and .relaylead/worktrees/.
// The same goes for the output folders of the files delivery: out/<mission>/<id>, or out/<id> in 0.1.
const path = require('node:path');

const FORMAT = 2;

function isPerMission(mission) {
  return mission.format === FORMAT;
}

function integrationBranch(name) {
  return `relaylead/${name}/integration`;
}

function worktreesDir(mission) {
  const root = path.join(mission.dir, '.relaylead', 'worktrees');
  return isPerMission(mission) ? path.join(root, mission.name) : root;
}

function integrationDir(mission) {
  return path.join(worktreesDir(mission), '_integration');
}

function taskDir(mission, id) {
  return path.join(worktreesDir(mission), id);
}

function outDir(mission, id) {
  const root = path.join(mission.dir, 'out');
  return isPerMission(mission) ? path.join(root, mission.name, id) : path.join(root, id);
}

module.exports = { FORMAT, isPerMission, integrationBranch, worktreesDir, integrationDir, taskDir, outDir };
