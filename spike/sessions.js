// Liste les sessions Claude Code et arrête/supprime une session par son nom exact (via l'identifiant court).
const { spawnSync } = require('node:child_process');

function listSessions({ all = false, cwd } = {}) {
  const args = ['agents', '--json'];
  if (all) args.push('--all');
  if (cwd) args.push('--cwd', cwd);
  const r = spawnSync('claude', args, { encoding: 'utf8' });
  let rows = [];
  try { rows = JSON.parse(r.stdout || '[]'); } catch { rows = []; }
  return rows.map(({ id, sessionId, name, state, status, waitingFor, pid, cwd: dir, startedAt }) =>
    ({ id, sessionId, name, state, status, waitingFor, pid, cwd: dir, startedAt }));
}

function byName(name) {
  return listSessions({ all: true }).filter((s) => s.name === name && s.id);
}

function run(cmd, id) {
  const r = spawnSync('claude', [cmd, id], { encoding: 'utf8' });
  console.log(`claude ${cmd} ${id} → code ${r.status} ${(r.stdout + r.stderr).trim()}`);
  return r.status;
}

if (require.main === module) {
  const [cmd, name] = process.argv.slice(2);
  if (cmd === 'stop' || cmd === 'rm') {
    const found = byName(name);
    if (!found.length) console.log(`aucune session nommée ${name}`);
    for (const s of found) run(cmd, s.id);
  } else {
    const all = process.argv.includes('--all');
    const cwdIdx = process.argv.indexOf('--cwd');
    const rows = listSessions({ all, cwd: cwdIdx > 0 ? process.argv[cwdIdx + 1] : undefined });
    const only = process.argv.includes('--rl') ? rows.filter((s) => (s.name || '').startsWith('rl-')) : rows;
    console.log(JSON.stringify(only, null, 1));
  }
}

module.exports = { listSessions, byName };
