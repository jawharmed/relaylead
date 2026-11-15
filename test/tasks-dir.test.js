const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('../fixtures/helpers');
const tasksDir = require('../sources/tasks-dir');

function setup(files) {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'tasks'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, 'tasks', name), content);
  }
  return root;
}

const A = '---\ntitle: First\nstate: done\ndepends: []\n---\n\nDo the first thing.\n';
const B = '---\ntitle: Second\nstate: todo\ndepends: [a]\nask: Which database?\n---\n\nDo the second thing.\n';

test('lists tasks with their front matter (ask included)', () => {
  const root = setup({ 'b.md': B, 'a.md': A, 'notes.txt': 'ignored' });
  const tasks = tasksDir.list(root, 'tasks');
  assert.deepStrictEqual(tasks, [
    { id: 'a', title: 'First', state: 'done', depends: [], ask: null, body: 'Do the first thing.\n' },
    { id: 'b', title: 'Second', state: 'todo', depends: ['a'], ask: 'Which database?', body: 'Do the second thing.\n' },
  ]);
  assert.deepStrictEqual(tasksDir.list(root, 'missing'), []);
});

test('ready respects dependencies', () => {
  const c = '---\ntitle: Third\ndepends: [a, b]\n---\nBody\n';
  const root = setup({ 'a.md': A, 'b.md': B, 'c.md': c });
  const ids = tasksDir.ready(tasksDir.list(root, 'tasks')).map((t) => t.id);
  assert.deepStrictEqual(ids, ['b']);
});

test('unknown dependency is reported', () => {
  const root = setup({ 'b.md': B });
  assert.throws(() => tasksDir.ready(tasksDir.list(root, 'tasks')), /tasks\/b\.md.*\ba\b/);
});

test('markDone rewrites only the state line', () => {
  const root = setup({ 'b.md': B });
  tasksDir.markDone(root, 'tasks', 'b');
  const after = fs.readFileSync(path.join(root, 'tasks', 'b.md'), 'utf8');
  assert.strictEqual(after, B.replace('state: todo', 'state: done'));
  // No state line yet: it is added before the closing ---.
  const root2 = setup({ 'x.md': '---\ntitle: X\n---\nBody\n' });
  tasksDir.markDone(root2, 'tasks', 'x');
  assert.strictEqual(fs.readFileSync(path.join(root2, 'tasks', 'x.md'), 'utf8'), '---\ntitle: X\nstate: done\n---\nBody\n');
});

test('CRLF files are read', () => {
  const crlf = B.replace(/\n/g, '\r\n');
  const root = setup({ 'b.md': crlf });
  const [task] = tasksDir.list(root, 'tasks');
  assert.deepStrictEqual(task, { id: 'b', title: 'Second', state: 'todo', depends: ['a'], ask: 'Which database?', body: 'Do the second thing.\n' });
  tasksDir.markDone(root, 'tasks', 'b');
  const after = fs.readFileSync(path.join(root, 'tasks', 'b.md'), 'utf8');
  assert.strictEqual(after, crlf.replace('state: todo', 'state: done'));
});
