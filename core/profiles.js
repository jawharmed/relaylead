// A profile is a Markdown file: a small front matter (agent, model, effort, tools) and the
// instructions for the session as the body.
const fs = require('node:fs');
const path = require('node:path');
const { home } = require('./paths');
const { parseFrontMatter, parseList } = require('../sources/tasks-dir');

const DEFAULT_CATALOG = path.join(__dirname, '..', 'catalog', 'profiles');

// Where to look, most specific first: the project, then the user, then the built-in catalog.
function profileFolders(dir, catalogDir) {
  return [path.join(dir, '.relaylead', 'profiles'), path.join(home(), 'profiles'), catalogDir];
}

function loadProfile(name, { dir, catalogDir = DEFAULT_CATALOG }) {
  const folders = profileFolders(dir, catalogDir);
  for (const folder of folders) {
    const file = path.join(folder, `${name}.md`);
    if (!fs.existsSync(file)) continue;
    const { fields, body } = parseFrontMatter(fs.readFileSync(file, 'utf8'));
    return {
      name,
      agent: fields.agent || 'claude',
      model: fields.model || null,
      effort: fields.effort || null,
      tools: fields.tools ? parseList(fields.tools) : [],
      instructions: body,
    };
  }
  const err = new Error(`profile "${name}" not found; looked in: ${folders.join(', ')}`);
  err.code = 'unknown-profile';
  throw err;
}

module.exports = { loadProfile };
