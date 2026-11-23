const fs = require('node:fs');
const path = require('node:path');
const { retrySync } = require('./timing');
const { home } = require('./paths');

const DEFAULT_WRITE_RETRY_MS = 2000;

// The budget of the Windows retries below, in ms. An environment variable, not a configuration key:
// this file also serves the hooks, which do not read the configuration (the configuration uses it itself).
function writeRetryMs() {
  const value = process.env.RELAYLEAD_WRITE_RETRY_MS;
  return /^\d+$/.test(value || '') ? Number(value) : DEFAULT_WRITE_RETRY_MS;
}

// On Windows, opening or renaming a file is denied (EPERM, EBUSY, EACCES) while another
// process has it open or is renaming over it. The denial is short-lived, so retry for up
// to the budget (2 s by default). The delay grows and has a random part so two writers do not retry in lockstep.
function withWindowsRetry(action, budgetMs = writeRetryMs()) {
  return retrySync(action, {
    retryIf: (err) => process.platform === 'win32' && ['EPERM', 'EBUSY', 'EACCES'].includes(err.code),
    budgetMs,
    delayMs: (attempt) => Math.min(10 * attempt, 100) + Math.floor(Math.random() * 21),
  });
}

// A temporary file that cannot be removed must not hide the error that made us remove it.
function removeQuietly(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // ignored on purpose
  }
}

// Under RELAYLEAD_HOME, what relaylead makes is for the user alone: folders in 700, files in 600.
// The questions, logs and settings of the missions are nobody else's business on a shared Mac.
const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;

function inHome(file) {
  const base = path.resolve(home());
  const full = path.resolve(file);
  return full === base || full.startsWith(base + path.sep);
}

// Makes `dir` and its missing parents; private ones under RELAYLEAD_HOME (the home itself included).
function makeDir(dir) {
  fs.mkdirSync(dir, inHome(dir) ? { recursive: true, mode: PRIVATE_DIR } : { recursive: true });
}

// The mode a new file gets when the caller gives none: private under RELAYLEAD_HOME, the usual one elsewhere.
function defaultMode(file, mode) {
  return mode === undefined && inHome(file) ? PRIVATE_FILE : mode;
}

// Puts RELAYLEAD_HOME back in 700 when it is readable by others (a folder made before 0.4, or by
// hand). Returns the former mode (as "755") when it was changed, null otherwise. Nothing on Windows,
// and nothing when the folder does not exist.
function secureHome() {
  const dir = home();
  if (process.platform === 'win32' || !fs.existsSync(dir)) return null;
  const mode = fs.statSync(dir).mode & 0o777;
  if (mode === PRIVATE_DIR) return null;
  fs.chmodSync(dir, PRIVATE_DIR);
  return mode.toString(8);
}

// Write to a temporary file in the same folder, then rename: readers never see a partial file.
// `mode` is applied by chmod: the umask would reduce it if it were given to writeFileSync.
// `createDir: false` fails (ENOENT) when the folder is missing, instead of creating it.
function writeText(file, text, { mode: given, retryMs, createDir = true } = {}) {
  const mode = defaultMode(file, given);
  if (createDir) makeDir(path.dirname(file));
  const random = Math.random().toString(36).slice(2, 10);
  const tmp = `${file}.${process.pid}.${random}.tmp`;
  try {
    // Created with `mode` at once, so a secret is never readable by others, even for a moment.
    fs.writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    withWindowsRetry(() => fs.renameSync(tmp, file), retryMs);
  } catch (err) {
    removeQuietly(tmp);
    throw err;
  }
}

// Adds `text` at the end of a file (made when missing). For a file with a single writer, a line at a time.
function appendText(file, text) {
  makeDir(path.dirname(file));
  withWindowsRetry(() => fs.appendFileSync(file, text, { mode: defaultMode(file) }));
}

function writeJson(file, data, options) {
  writeText(file, JSON.stringify(data, null, 2) + '\n', options);
}

// Like writeText, but only if the file does not exist yet: returns false when someone else wrote it first.
// The text goes to a temporary file, then a hard link makes it appear complete, or fails if the file exists.
function writeTextExclusive(file, text) {
  makeDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode: defaultMode(file) });
    withWindowsRetry(() => fs.linkSync(tmp, file));
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  } finally {
    removeQuietly(tmp);
  }
}

function writeJsonExclusive(file, data) {
  return writeTextExclusive(file, JSON.stringify(data, null, 2) + '\n');
}

function readJson(file, fallback) {
  let text;
  try {
    text = withWindowsRetry(() => fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON in ${file}: ${err.message}`);
  }
}

module.exports = { appendText, writeText, writeTextExclusive, writeRetryMs, writeJson, writeJsonExclusive, readJson, withWindowsRetry, secureHome };
