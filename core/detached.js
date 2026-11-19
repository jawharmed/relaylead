// Helpers that outlive the command that starts them: the reaper of a lead, the watcher's loop.
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'relaylead.js');
// A helper is not a session: it gets none of the variables that tell a mission session who it is.
const SESSION_VARS = ['RELAYLEAD_MISSION', 'RELAYLEAD_TASK', 'RELAYLEAD_ATTEMPT', 'RELAYLEAD_ROLE', 'RELAYLEAD_SESSION'];

// Runs `node bin/relaylead.js ...args` on its own, detached, and resolves with its pid once it has
// started. No shell, so a path with spaces or quotes is passed as it is. It runs in the user's home
// folder: Windows cannot delete a folder that a process has as its current one.
async function spawnDetached(args) {
  const env = { ...process.env };
  for (const name of SESSION_VARS) delete env[name];
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: os.homedir(),
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  // Without an 'error' listener, a failed start would crash the whole process.
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  return child.pid;
}

module.exports = { spawnDetached };
