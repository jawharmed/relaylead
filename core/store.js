const fs = require('node:fs');
const path = require('node:path');

const RETRY_BUDGET_MS = 2000;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// On Windows, opening or renaming a file is denied (EPERM, EBUSY, EACCES) while another
// process has it open or is renaming over it. The denial is short-lived, so retry for up
// to about 2 s. The delay grows and has a random part so two writers do not retry in lockstep.
function withWindowsRetry(action) {
  const start = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      return action();
    } catch (err) {
      const busy = err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES';
      if (!busy || process.platform !== 'win32' || Date.now() - start >= RETRY_BUDGET_MS) throw err;
      sleep(Math.min(10 * attempt, 100) + Math.floor(Math.random() * 21));
    }
  }
}

// Write to a temporary file in the same folder, then rename: readers never see a partial file.
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const random = Math.random().toString(36).slice(2, 10);
  const tmp = `${file}.${process.pid}.${random}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    withWindowsRetry(() => fs.renameSync(tmp, file));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// Like writeJson, but only if the file does not exist yet: returns false when someone else wrote it first.
// The data goes to a temporary file, then a hard link makes it appear complete, or fails if the file exists.
function writeJsonExclusive(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    withWindowsRetry(() => fs.linkSync(tmp, file));
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
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

module.exports = { writeJson, writeJsonExclusive, readJson };
