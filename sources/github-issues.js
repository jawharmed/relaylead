// Task source "GitHub issues": each issue with the label (default "relaylead") is a task issue-<n>.
// An open issue is to do, a closed one is done. `repo` ("owner/name") is optional: without it, gh
// takes the repository of the folder it runs in (`cwd`, the user's checkout).
const { gh, ghJson } = require('../core/github');

function repoArgs(source) {
  return source.repo ? ['--repo', source.repo] : [];
}

function issueNumber(id) {
  return id.slice('issue-'.length);
}

// The tasks, in the same shape as tasks-dir's list(). Issues have no dependencies and ask nothing.
function list(source, { cwd } = {}) {
  const label = source.label || 'relaylead';
  const args = ['issue', 'list', '--state', 'all', '--label', label, '--limit', '100', '--json', 'number,title,body,state'];
  return ghJson([...args, ...repoArgs(source)], { cwd }).map((issue) => ({
    id: `issue-${issue.number}`,
    file: null,
    title: issue.title,
    state: issue.state === 'CLOSED' ? 'done' : 'todo',
    depends: [],
    ask: null,
    body: issue.body || '',
  }));
}

// Closes the issue of task `id`. gh closes a closed issue without an error: a delivery played
// again closes it again.
function markDone(source, id, { cwd } = {}) {
  gh(['issue', 'close', issueNumber(id), '--comment', 'Delivered by relaylead', ...repoArgs(source)], { cwd });
}

module.exports = { list, markDone, issueNumber };
