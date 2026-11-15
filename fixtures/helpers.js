// Small helpers shared by the tests (kept out of test/ so node --test does not run them).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tmpDir(prefix = 'relaylead-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A writable-like object that keeps everything written to it.
function capture() {
  return {
    text: '',
    write(chunk) {
      this.text += chunk;
    },
  };
}

function makeIo(overrides) {
  return { out: capture(), err: capture(), env: {}, cwd: process.cwd(), ...overrides };
}

// Calls `check` every 50 ms until it returns true; fails after `ms` milliseconds. On a timeout, the
// error also carries `explain()`, so a failure on a CI runner says what happened.
async function waitFor(check, ms, what, explain) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}` + (explain ? '\n' + explain() : ''));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// The environment of a person in a terminal: the tests may themselves run inside a mission session,
// whose RELAYLEAD_MISSION and RELAYLEAD_TASK would make the CLI refuse the user's commands.
function userEnv() {
  const env = { ...process.env };
  delete env.RELAYLEAD_MISSION;
  delete env.RELAYLEAD_TASK;
  return env;
}

module.exports = { tmpDir, makeIo, waitFor, userEnv };
