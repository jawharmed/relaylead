// The watcher's log, ~/.relaylead/watcher.log: one line per action, `<ISO time> <mission or -> <action>
// <detail>`, in English. Only paths.js and store.js are loaded here, so missions.js can log too
// without loading watcher.js, which loads it.
const fs = require('node:fs');
const path = require('node:path');
const { home } = require('./paths');
const { withWindowsRetry } = require('./store');

function watchLogFile() {
  return path.join(home(), 'watcher.log');
}

// Never throws: the log is a record only, the action is already decided.
function watchLog(mission, action, detail) {
  try {
    const line = `${new Date().toISOString()} ${mission || '-'} ${action}${detail ? ` ${detail}` : ''}\n`;
    fs.mkdirSync(home(), { recursive: true });
    withWindowsRetry(() => fs.appendFileSync(watchLogFile(), line));
  } catch {
    // ignored on purpose
  }
}

// The size of the log now, 0 when there is none: what a command reads from once it is done.
function watchLogSize() {
  try {
    return fs.statSync(watchLogFile()).size;
  } catch {
    return 0;
  }
}

// The lines written since the log had `size` bytes. A log moved to watcher.log.1 meanwhile starts
// again from its first byte.
function watchLogSince(size) {
  let text;
  try {
    text = withWindowsRetry(() => fs.readFileSync(watchLogFile()));
  } catch {
    return '';
  }
  return text.subarray(text.length >= size ? size : 0).toString('utf8');
}

module.exports = { watchLog, watchLogFile, watchLogSize, watchLogSince };
