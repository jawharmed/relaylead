// Notifications to the user, through macOS's own notifications (osascript, without a shell). Nothing
// on other systems, nor with RELAYLEAD_NOTIFY=off (set for the whole test suite). The program is
// started detached and not waited for: a hook never waits for it. Never throws.
// RELAYLEAD_NOTIFY_BIN, for the tests: a Node script run in place of osascript, with the same arguments.
const { spawn } = require('node:child_process');

const MAX_LENGTH = 200;

// Quotes and backslashes would end or change the AppleScript string: they are taken out.
function clean(text) {
  return String(text).replace(/["\\]/g, '').slice(0, MAX_LENGTH);
}

function notify({ title, text }) {
  try {
    if (process.env.RELAYLEAD_NOTIFY === 'off') return;
    const bin = process.env.RELAYLEAD_NOTIFY_BIN;
    if (!bin && process.platform !== 'darwin') return;
    const args = ['-e', `display notification "${clean(text)}" with title "${clean(title)}"`];
    const [file, fileArgs] = bin ? [process.execPath, [bin, ...args]] : ['osascript', args];
    const child = spawn(file, fileArgs, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {}); // osascript missing: no notification, no crash
    child.unref();
  } catch {
    // A notification is a courtesy: nothing depends on it.
  }
}

module.exports = { notify };
