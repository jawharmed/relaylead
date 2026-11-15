const fs = require('node:fs');
const path = require('node:path');

const MAX_ATTEMPTS = 5;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// On Windows, opening or renaming a file can fail briefly while another process
// is renaming or reading it. Retry a few times, only for those errors.
function withWindowsRetry(action) {
  for (let attempt = 1; ; attempt++) {
    try {
      return action();
    } catch (err) {
      const busy = err.code === 'EPERM' || err.code === 'EBUSY';
      if (!busy || process.platform !== 'win32' || attempt >= MAX_ATTEMPTS) throw err;
      sleep(50);
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

module.exports = { writeJson, readJson };
