// The project memory: `<project>/.relaylead/memoire.md`, kept by the lead (conventions of the project, one
// line per past mission, lessons). Always in the project folder of the mission (the main repository, an
// absolute path), never in a worktree. Only the lead of a mission reads and replaces it; the previous
// version goes to `.relaylead/memoire-archive/`, which nobody reads again.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { home, missionDir } = require('./paths');
const { loadConfig } = require('./config');
const { codedError } = require('./messages');
const { writeText, writeJson, readJson } = require('./store');
const { tryCreateLock, isStaleLock, removeQuietly, takeOverStaleLock } = require('./mission-lock');
const { runFileSync } = require('./run-file');
const { sleep } = require('./timing');

const MEMORY_PATH = '.relaylead/memoire.md';
const ARCHIVE_PATH = '.relaylead/memoire-archive/';
// Like the other git calls of relaylead: git starts no background maintenance that would hold a lock.
const NO_MAINTENANCE = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];
const LOCK_WAIT_MS = 10 * 1000;

// The root of the main working tree of the repository `dir` belongs to, whether `dir` is that root, a
// sub-folder or a linked worktree: the memory lives there and nowhere else. A folder that is not in a
// git repository is its own root.
function projectRoot(dir) {
  const real = fs.realpathSync.native(dir);
  try {
    const out = runFileSync('git', [...NO_MAINTENANCE, 'rev-parse', '--git-common-dir'], { cwd: real, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const common = path.resolve(real, out.trim());
    return path.basename(common) === '.git' ? fs.realpathSync.native(path.dirname(common)) : real;
  } catch {
    return real;
  }
}

function memoryFile(dir) {
  return path.join(projectRoot(dir), '.relaylead', 'memoire.md');
}

function archiveDir(dir) {
  return path.join(projectRoot(dir), '.relaylead', 'memoire-archive');
}

// { enabled, maxLines, versioned } of a project, the defaults for what is missing or not valid.
function memorySettings(dir) {
  const { memory } = loadConfig({ dir: projectRoot(dir) });
  // The ceilings are bounded: a setting out of range (or not a whole number) is the default.
  const maxLines = Number.isInteger(memory.maxLines) && memory.maxLines >= 1 && memory.maxLines <= 1000 ? memory.maxLines : 200;
  const maxBytes = Number.isInteger(memory.maxBytes) && memory.maxBytes >= 1024 && memory.maxBytes <= 65536 ? memory.maxBytes : 16384;
  return { enabled: memory.enabled !== false, maxLines, maxBytes, versioned: memory.versioned === true };
}

// The lines of a text, without the empty end.
function countLines(text) {
  return text === '' ? 0 : text.replace(/\n+$/, '').split('\n').length;
}

// The memory as it is: '' when there is none yet.
function readMemoryText(dir) {
  try {
    return fs.readFileSync(memoryFile(dir), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

// What `memory show` gives the lead to pass back to `memory write --base`: write refuses when the file
// is no longer the one that was read.
function fingerprint(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}

// { text, lines, bytes, maxLines, maxBytes, tooBig, tooLong, shown, hidden, fingerprint } of a project; used by `memory show` and by doctor.
function readMemory(dir) {
  const { maxLines, maxBytes } = memorySettings(dir);
  const text = readMemoryText(dir);
  const lines = countLines(text);
  const bytes = Buffer.byteLength(text);
  const tooBig = bytes > maxBytes;
  const tooLong = tooBig || lines > maxLines;
  // What `memory show` prints: all of it, or when over a ceiling the first lines that fit under both.
  let shown = text;
  if (tooLong) {
    shown = '';
    for (const line of text.split('\n').slice(0, maxLines)) {
      if (Buffer.byteLength(shown + line + '\n') > maxBytes) break;
      shown += line + '\n';
    }
  }
  return { text, lines, bytes, maxLines, maxBytes, tooBig, tooLong, shown, hidden: lines - countLines(shown), fingerprint: fingerprint(text) };
}

// Keeps .git/info/exclude right for the memory, the .gitignore never touched. Not versioned: the memory
// and its archive are excluded. Versioned: everything under .relaylead/ is excluded except the memory
// (`.relaylead/*` then `!.relaylead/memoire.md`: git cannot re-include a file of an excluded folder, hence
// the `/*`), and the archive stays excluded. Does nothing outside a git repository.
function updateExclude(dir, versioned) {
  dir = projectRoot(dir);
  let file;
  try {
    const out = runFileSync('git', [...NO_MAINTENANCE, 'rev-parse', '--git-path', 'info/exclude'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    file = path.resolve(dir, out.trim());
  } catch {
    return;
  }
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const before = text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  // The lines of an earlier choice go; the ones that stay in either mode are kept as they are.
  const dropped = versioned ? ['.relaylead/', MEMORY_PATH] : ['!' + MEMORY_PATH, '.relaylead/*'];
  const wanted = versioned ? ['.relaylead/*', '!' + MEMORY_PATH] : [MEMORY_PATH, ARCHIVE_PATH];
  const lines = before.filter((line) => !dropped.includes(line));
  for (const line of wanted) if (!lines.includes(line)) lines.push(line);
  if (lines.join('\n') === before.join('\n')) return;
  writeText(file, lines.join('\n') + '\n');
}

// One writer at a time per repository: a lock file in ~/.relaylead/locks, named after the repository.
async function withMemoryLock(dir, action) {
  dir = projectRoot(dir);
  const hash = crypto.createHash('sha1').update(dir).digest('hex').slice(0, 16);
  const file = path.join(home(), 'locks', `memory-${hash}.lock`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const giveUpAt = Date.now() + LOCK_WAIT_MS;
  while (!tryCreateLock(file, 'memory write')) {
    if (isStaleLock(file) && (await takeOverStaleLock(file))) continue;
    if (Date.now() > giveUpAt) throw codedError('memory-busy', { dir });
    await sleep(50);
  }
  try {
    return await action();
  } finally {
    await removeQuietly(file);
  }
}

// Replaces the memory of the project of `mission` by `text`. Refused when the memory is off, when the text is
// empty or longer than the ceiling, or when the file is not the one `base` (its fingerprint) was taken from. The previous version goes to the archive. Returns the number of lines.
async function writeMemory(mission, text, base) {
  const dir = projectRoot(require('./missions').readMission(mission).dir); // lazy: missions.js needs the delivery, which needs this file
  const { enabled, maxLines, maxBytes, versioned } = memorySettings(dir);
  if (!enabled) throw codedError('memory-disabled', {});
  const body = String(text).replace(/\s+$/, '');
  if (!body.trim()) throw codedError('bad-memory', {});
  const lines = countLines(body);
  if (lines > maxLines) throw codedError('memory-too-long', { lines, max: maxLines });
  const bytes = Buffer.byteLength(body + '\n');
  if (bytes > maxBytes) throw codedError('memory-too-big', { bytes, max: maxBytes });
  await withMemoryLock(dir, async () => {
    const before = readMemoryText(dir);
    // Another mission may have written since the lead read: its compaction would be lost.
    if (fingerprint(before) !== base) throw codedError('memory-changed', {});
    if (before.trim() && before !== body + '\n') {
      // A name that cannot clash: the date, then the pid.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      writeText(path.join(archiveDir(dir), `${stamp}-${process.pid}.md`), before);
    }
    writeText(memoryFile(dir), body + '\n');
    updateExclude(dir, versioned);
  });
  // Noted by the core, for the end of the mission (requireCompaction).
  writeJson(path.join(missionDir(mission), 'memory.json'), { writtenAt: new Date().toISOString() });
  return lines;
}

// A lead may not declare its mission done while the memory is on and the mission has not written it
// (the compaction): the error says what to run.
function requireCompaction(mission) {
  const dir = require('./missions').readMission(mission).dir;
  if (!memorySettings(dir).enabled) return;
  if (readJson(path.join(missionDir(mission), 'memory.json'), null)) return;
  throw codedError('memory-not-compacted', {});
}

module.exports = { requireCompaction, projectRoot, memoryFile, archiveDir, memorySettings, readMemory, writeMemory, updateExclude, countLines };
