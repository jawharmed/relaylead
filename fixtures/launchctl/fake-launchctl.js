// A fake `launchctl`: notes every call in FAKE_LAUNCHCTL_STATE/calls.log (one JSON array per line) and
// keeps a `loaded` marker, so bootstrap, bootout and print agree with each other like the real one.
const fs = require('node:fs');
const path = require('node:path');

const STATE_DIR = process.env.FAKE_LAUNCHCTL_STATE;
const LOADED = path.join(STATE_DIR, 'loaded');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(STATE_DIR, 'calls.log'), JSON.stringify(args) + '\n');

const loaded = fs.existsSync(LOADED);
if (args[0] === 'bootstrap') {
  // The real one refuses a service that is already loaded.
  if (loaded) {
    process.stderr.write('Bootstrap failed: 5: Input/output error\n');
    process.exitCode = 5;
  } else {
    fs.writeFileSync(LOADED, '');
  }
} else if (args[0] === 'bootout') {
  if (!loaded) {
    process.stderr.write('Boot-out failed: 3: No such process\n');
    process.exitCode = 3;
  } else {
    fs.rmSync(LOADED);
  }
} else if (args[0] === 'print') {
  process.exitCode = loaded ? 0 : 113;
} else {
  process.stderr.write(`fake launchctl: unexpected arguments ${JSON.stringify(args)}\n`);
  process.exitCode = 2;
}
