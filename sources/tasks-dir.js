// Task source: one Markdown file per task, with a small front matter.
const fs = require('node:fs');
const path = require('node:path');

const OPENING_LINE = /^---[ \t]*\r?\n/;
const CLOSING_LINE = /^---[ \t]*(?:\r?\n|$)/m;

// The front matter sits between a first line "---" (at the very start of the
// file) and the next "---" line. Works with LF and CRLF line endings.
// Returns null when there is none, else:
// { header, closingStart (offset of the closing line), end (offset after it) }.
function matchFrontMatter(text) {
  const opening = OPENING_LINE.exec(text);
  if (!opening) return null;
  const rest = text.slice(opening[0].length);
  const closing = CLOSING_LINE.exec(rest);
  if (!closing) return null;
  const closingStart = opening[0].length + closing.index;
  return {
    header: rest.slice(0, closing.index),
    closingStart,
    end: closingStart + closing[0].length,
  };
}

function parseList(value) {
  const inner = value.replace(/^\[/, '').replace(/\]$/, '');
  return inner.split(',').map((item) => item.trim()).filter((item) => item !== '');
}

// Splits a Markdown file into its "key: value" front matter fields and its body.
// Without front matter, fields is empty and body is the whole text.
function parseFrontMatter(text) {
  const match = matchFrontMatter(text);
  const fields = {};
  if (!match) return { fields, body: text };
  for (const line of match.header.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { fields, body: text.slice(match.end).replace(/\r\n/g, '\n').replace(/^\n/, '') };
}

function parseTask(id, file, text) {
  const { fields, body } = parseFrontMatter(text);
  return {
    id,
    file,
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
    .map((id) => {
      const file = path.join(dir, `${id}.md`);
      return parseTask(id, file, fs.readFileSync(path.join(root, file), 'utf8'));
    });
}

// Throws when a task depends on a task that does not exist.
function checkDependencies(tasks) {
  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    for (const dep of task.depends) {
      if (!ids.has(dep)) {
        throw new Error(`${task.file} depends on unknown task "${dep}"`);
      }
    }
  }
}

// Tasks that are todo and whose dependencies are all done.
function ready(tasks) {
  checkDependencies(tasks);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks.filter(
    (task) => task.state === 'todo' && task.depends.every((dep) => byId.get(dep).state === 'done'),
  );
}

// Rewrites only the "state:" line of the front matter; every other byte stays.
function markDone(root, dir, id) {
  const file = path.join(root, dir, `${id}.md`);
  const text = fs.readFileSync(file, 'utf8');
  const match = matchFrontMatter(text);
  if (!match) throw new Error(`${dir}/${id}.md has no front matter`);

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let updated;
  if (/^state:.*$/m.test(match.header)) {
    const newHeader = match.header.replace(/^state:.*$/m, 'state: done');
    const start = match.closingStart - match.header.length;
    updated = text.slice(0, start) + newHeader + text.slice(match.closingStart);
  } else {
    // The header is empty or ends with a line break: add the line just before "---".
    updated = text.slice(0, match.closingStart) + `state: done${eol}` + text.slice(match.closingStart);
  }

  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, updated);
  fs.renameSync(temp, file);
}

module.exports = { list, ready, checkDependencies, markDone, parseFrontMatter, parseList };
