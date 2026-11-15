const os = require('node:os');
const path = require('node:path');

// Read at call time so tests can change RELAYLEAD_HOME per test.
function home() {
  return process.env.RELAYLEAD_HOME || path.join(os.homedir(), '.relaylead');
}

function missionDir(name) {
  return path.join(home(), 'missions', name);
}

// Lowercase, [a-z0-9-] only, merged dashes, 40 characters at most.
function slug(text) {
  const result = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  if (!result) throw new Error('cannot build a name from an empty text');
  return result;
}

module.exports = { home, missionDir, slug };
