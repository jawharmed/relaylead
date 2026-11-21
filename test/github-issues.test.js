const test = require('node:test');
const assert = require('node:assert');
const githubIssues = require('../sources/github-issues');
const { fakeGh, issue } = require('../fixtures/github');

test('the issues with the label are the tasks: open is todo, closed is done', (t) => {
  const github = fakeGh(t, {
    issues: [issue(1, 'first'), issue(2, 'second', 'CLOSED'), issue(3, 'third'), { ...issue(4, 'other'), labels: ['bug'] }],
  });
  const tasks = githubIssues.list({ type: 'github-issues', repo: 'owner/name' });
  assert.deepStrictEqual(
    tasks.map((task) => [task.id, task.state, task.title]),
    [
      ['issue-1', 'todo', 'first'],
      ['issue-2', 'done', 'second'],
      ['issue-3', 'todo', 'third'],
    ],
  );
  assert.deepStrictEqual(tasks[0], { id: 'issue-1', file: null, title: 'first', state: 'todo', depends: [], ask: null, body: 'Do first.' });
  const [call] = github.calls();
  assert.strictEqual(call[call.indexOf('--label') + 1], 'relaylead');
  assert.strictEqual(call[call.indexOf('--repo') + 1], 'owner/name');
});

test('markDone closes the issue, and closing it again is no error', (t) => {
  const github = fakeGh(t, { issues: [issue(1, 'first')] });
  const source = { type: 'github-issues', label: 'relaylead' };
  githubIssues.markDone(source, 'issue-1');
  githubIssues.markDone(source, 'issue-1');
  assert.strictEqual(github.read().issues[0].state, 'CLOSED');
  assert.ok(!github.calls()[0].includes('--repo'));
});
