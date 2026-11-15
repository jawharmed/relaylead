// Reads what `claude` prints: the launch output and the rows of `claude agents --json`.
const ANSI_COLOURS = /\u001b\[[0-9;]*m/g;
const SHORT_ID = /\b[0-9a-f]{8}\b/g;

// Returns { shortId } or { shortId, copyOf } (a copy was started instead of a wake),
// or { error: 'untrusted-dir' | 'unknown' }.
function parseLaunchOutput(text) {
  const clean = String(text).replace(ANSI_COLOURS, '').replace(/\r/g, '');
  if (/Workspace not trusted/i.test(clean)) return { error: 'untrusted-dir' };
  const launched = /backgrounded \u00b7 (\S+) \u00b7/.exec(clean);
  if (!launched) return { error: 'unknown' };
  const shortId = launched[1];
  const note = clean.split('\n').find((line) => line.includes('started a copy as'));
  if (!note) return { shortId };
  const original = (note.match(SHORT_ID) || []).find((id) => id !== shortId);
  return { shortId, copyOf: original || null };
}

// One row of `claude agents --json` to the adapter's Session. "blocked" only means the
// session waits for an input, so it becomes "waiting".
function mapState(row) {
  const parts = String(row.name || '').split('/');
  return {
    sessionId: row.sessionId,
    shortId: row.id,
    name: row.name,
    role: parts[1] === 'lead' ? 'lead' : 'crew',
    state: row.state === 'blocked' ? 'waiting' : row.state,
    pid: row.pid || null,
    cwd: row.cwd,
  };
}

module.exports = { parseLaunchOutput, mapState };
