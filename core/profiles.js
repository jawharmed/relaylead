// Profiles and methods are Markdown files: a small front matter and a body.
// A profile's front matter says how to run a session (agent, model, effort, tools) and its body
// gives the session's instructions. A method's body is the loop the lead follows.
const fs = require('node:fs');
const path = require('node:path');
const { home } = require('./paths');
const { parseFrontMatter, parseList } = require('../sources/tasks-dir');

const CATALOG = path.join(__dirname, '..', 'catalog');

// Reads <name>.md of a `kind` ('profile' or 'method'), most specific folder first: the project,
// then the user, then the built-in catalog.
function readDefinition(kind, name, dir, catalogDir) {
  const folders = [path.join(dir, '.relaylead', `${kind}s`), path.join(home(), `${kind}s`), catalogDir];
  for (const folder of folders) {
    const file = path.join(folder, `${name}.md`);
    if (fs.existsSync(file)) return parseFrontMatter(fs.readFileSync(file, 'utf8'));
  }
  const err = new Error(`${kind} "${name}" not found; looked in: ${folders.join(', ')}`);
  err.code = `unknown-${kind}`;
  throw err;
}

function loadProfile(name, { dir, catalogDir = path.join(CATALOG, 'profiles') }) {
  const { fields, body } = readDefinition('profile', name, dir, catalogDir);
  return {
    name,
    agent: fields.agent || 'claude',
    model: fields.model || null,
    effort: fields.effort || null,
    tools: fields.tools ? parseList(fields.tools) : [],
    instructions: body,
  };
}

function loadMethod(name, { dir, catalogDir = path.join(CATALOG, 'methods') }) {
  const { body } = readDefinition('method', name, dir, catalogDir);
  return { name, instructions: body };
}

module.exports = { loadProfile, loadMethod };
