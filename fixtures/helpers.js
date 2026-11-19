// Small helpers shared by the tests (kept out of test/ so node --test does not run them).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A test file run alone (`node --test test/missions.test.js`) starts no watcher loop either, as under
// `npm test` (fixtures/run-tests.js). Its loops end with it: the file named by RELAYLEAD_TEST_RUN_FILE
// is refreshed every 10 s while this process lives, and goes when it exits; a loop ends once the file
// is gone or 60 s old (core/watcher.js), so also after a Ctrl-C or a kill -9, which skip 'exit'.
if (process.env.RELAYLEAD_WATCHER === undefined) process.env.RELAYLEAD_WATCHER = 'off';
if (!process.env.RELAYLEAD_TEST_RUN_FILE) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'relaylead-run-'));
  const file = path.join(folder, 'running');
  process.env.RELAYLEAD_TEST_RUN_FILE = file;
  fs.writeFileSync(file, '');
  const refresh = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(file, now, now);
    } catch {
      // the next refresh tries again
    }
  }, 10 * 1000);
  refresh.unref();
  process.on('exit', () => {
    try {
      fs.rmSync(folder, { recursive: true, force: true });
    } catch {
      // left in the temporary folder
    }
  });
}

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

// Whether a session of the fake agent has ended, judged on the file its agent writes as it ends
// (adapters/fake/watch-stop.js), never on its pid: on Windows, the pid of an ended process soon names
// another one, maybe of another test file, and the session would look alive.
function sessionEnded(session) {
  return fs.existsSync(session.endedFile);
}

// Kills a session of the fake agent the way `kill -9` would: its agent writes no end. Then writes the
// witness the killed session cannot write, which the adapter's list reads instead of its pid.
function killSession(session) {
  process.kill(session.pid, 'SIGKILL');
  fs.writeFileSync(session.killedFile, '');
}

// The environment of a person in a terminal: the tests may themselves run inside a mission session,
// whose RELAYLEAD_MISSION and RELAYLEAD_TASK would make the CLI refuse the user's commands, and whose
// RELAYLEAD_ROLE and RELAYLEAD_SESSION (a lead's) would get not-current-lead.
function userEnv() {
  const env = { ...process.env };
  delete env.RELAYLEAD_MISSION;
  delete env.RELAYLEAD_TASK;
  delete env.RELAYLEAD_ROLE;
  delete env.RELAYLEAD_SESSION;
  return env;
}

module.exports = { tmpDir, makeIo, waitFor, sessionEnded, killSession, userEnv };
