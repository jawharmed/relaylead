// The end of a fake session (agent.js), and the thread that watches its stop file.
//
// Two files per session, chosen by the adapter at launch (adapters/fake/index.js):
// - the stop file, written by the adapter's stop: the session must end;
// - the ended file, written here when the session ends: the adapter's list then says "done" without
//   reading the pid, which Windows may by now have given to another process.
// The ended file stays in the mission folder as long as the mission: its list needs it, and it goes
// with the folder when the mission is removed.
const fs = require('node:fs');
const { isMainThread, workerData } = require('node:worker_threads');

// Writes the ended file. Never throws: it also runs while the process exits.
function markEnded({ endedFile }) {
  try {
    fs.writeFileSync(endedFile, '');
  } catch {
    // The mission folder is gone: nobody will list the session.
  }
}

// As the watching thread (started by agent.js with the two paths as workerData): reads the stop file
// every 50 ms, even while the agent's own thread waits on a command, then ends the whole process,
// as a signal would. Its own pid cannot belong to another process.
if (!isMainThread) {
  setInterval(() => {
    if (!fs.existsSync(workerData.stopFile)) return;
    markEnded(workerData);
    process.kill(process.pid);
  }, 50);
}

module.exports = { markEnded };
