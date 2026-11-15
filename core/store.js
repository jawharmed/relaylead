const fs = require('node:fs');
const path = require('node:path');

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// On Windows, rename can fail briefly when another process holds the file.
function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const busy = err.code === 'EPERM' || err.code === 'EBUSY';
      if (!busy || process.platform !== 'win32' || attempt >= 5) throw err;
      sleep(50);
    }
  }
}

// Write to a temporary file in the same folder, then rename: readers never see a partial file.
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const random = Math.random().toString(36).slice(2, 10);
  const tmp = `${file}.${process.pid}.${random}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  try {
    renameWithRetry(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
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
