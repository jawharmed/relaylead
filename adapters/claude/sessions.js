// Reads what `claude` prints: the launch output and the rows of `claude agents --json`.
const ANSI_COLOURS = /\u001b\[[0-9;]*m/g;

// Returns { shortId } (a launch), { shortId, copyOf } (a copy was started instead of a wake),
// { shortId, woke: true } (a wake), or { error: 'untrusted-dir' | 'unknown' }.
// Recorded copy outputs: the backgrounded line has no name, or is missing altogether.
function parseLaunchOutput(text) {
  const clean = String(text).replace(ANSI_COLOURS, '').replace(/\r/g, '');
  if (/Workspace not trusted/i.test(clean)) return { error: 'untrusted-dir' };
  const copy = /started a copy as ([0-9a-f]{8})/.exec(clean);
  if (copy) {
    const original = /`claude attach ([0-9a-f]{8})`|continues ([0-9a-f]{8}) itself/.exec(clean);
    return { shortId: copy[1], copyOf: original ? original[1] || original[2] : null };
  }
  const woke = /woke session ([0-9a-f]{8})/.exec(clean);
  if (woke) return { shortId: woke[1], woke: true };
  const launched = /backgrounded \u00b7 ([0-9a-f]{8})/.exec(clean);
  return launched ? { shortId: launched[1] } : { error: 'unknown' };
}

// An unknown state counts as working: the watcher then waits instead of failing a task
// on a state this version does not know.
const STATES = { working: 'working', blocked: 'waiting', done: 'done', stopped: 'stopped', failed: 'failed' };

// One row of `claude agents --json` to the adapter's Session. "blocked" only means the
// session waits for an input, so it becomes "waiting".
function mapState(row) {
  const parts = String(row.name || '').split('/');
  return {
    sessionId: row.sessionId,
    shortId: row.id,
    name: row.name,
    role: parts[1] === 'lead' ? 'lead' : 'crew',
    state: STATES[row.state] || 'working',
    pid: row.pid || null,
    cwd: row.cwd,
  };
}

module.exports = { parseLaunchOutput, mapState };
