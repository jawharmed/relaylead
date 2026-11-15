// Task source: one Markdown file per task, with a small front matter.
const fs = require('node:fs');
const path = require('node:path');

// The front matter sits between a first line "---" and the next "---" line.
// Works with LF and CRLF line endings.
const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?^---[ \t]*(?:\r?\n|$)/m;

function parseList(value) {
  const inner = value.replace(/^\[/, '').replace(/\]$/, '');
  return inner.split(',').map((item) => item.trim()).filter((item) => item !== '');
}

function parseTask(id, text) {
  const match = text.startsWith('---') ? FRONT_MATTER.exec(text) : null;
  const fields = {};
  let body = text;
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon > 0) fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
    body = text.slice(match[0].length).replace(/\r\n/g, '\n').replace(/^\n/, '');
  }
  return {
    id,
    title: fields.title || id,
    state: fields.state || 'todo',
    depends: fields.depends ? parseList(fields.depends) : [],
    ask: fields.ask || null,
    body,
  };
}

function list(root, dir) {
  const folder = path.join(root, dir);
  if (!fs.existsSync(folder)) return [];
  return fs
    .readdirSync(folder)
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -3))
    .sort()
    .map((id) => parseTask(id, fs.readFileSync(path.join(folder, `${id}.md`), 'utf8')));
}

// Tasks that are todo and whose dependencies are all done.
function ready(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    for (const dep of task.depends) {
      if (!byId.has(dep)) {
        throw new Error(`tasks/${task.id}.md depends on unknown task "${dep}"`);
      }
    }
  }
  return tasks.filter(
    (task) => task.state === 'todo' && task.depends.every((dep) => byId.get(dep).state === 'done'),
  );
}

// Rewrites only the "state:" line of the front matter; every other byte stays.
function markDone(root, dir, id) {
  const file = path.join(root, dir, `${id}.md`);
  const text = fs.readFileSync(file, 'utf8');
  const match = text.startsWith('---') ? FRONT_MATTER.exec(text) : null;
  if (!match) throw new Error(`${dir}/${id}.md has no front matter`);

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const header = match[1];
  const newHeader = /^state:.*$/m.test(header)
    ? header.replace(/^state:.*$/m, 'state: done')
    : `${header}${eol}state: done`;
  const start = match[0].indexOf(header);
  const updated = text.slice(0, start) + newHeader + text.slice(start + header.length);

  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, updated);
  fs.renameSync(temp, file);
}

module.exports = { list, ready, markDone };
