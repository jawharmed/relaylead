// Process of a fake agent session. Usage: node agent.js <role>
// Like a real session, it acts only through the relaylead CLI, never by writing state files.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const CLI = path.join(__dirname, '..', '..', 'bin', 'relaylead.js');

// The env carries RELAYLEAD_MISSION and RELAYLEAD_HOME; no shell and no PATH lookup.
function relaylead(...args) {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true });
}

const role = process.argv[2];
if (role === 'lead') {
  relaylead('state', 'set', 'working');
}

// Stay alive until stopped, like a real session.
setInterval(() => {}, 60 * 1000);
