// Réveil d'une session inactive, recette retenue par l'essai :
// arrêter, attendre la fin du processus, reprendre SANS options depuis le dossier de la session,
// vérifier que la sortie nomme le même id (sinon c'est une copie).
// node spike/wake.js <id court> "<message>"
const { spawnSync } = require('node:child_process');
const { listSessions } = require('./sessions');

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const [shortId, message] = process.argv.slice(2);
const s = listSessions({ all: true }).find((x) => x.id === shortId);
if (!s) { console.error(`session ${shortId} introuvable`); process.exit(1); }
spawnSync('claude', ['stop', s.id]);
const t0 = Date.now();
while (alive(s.pid) && Date.now() - t0 < 60000) spawnSync(process.execPath, [`${__dirname}/wait.js`, '1']);
const r = spawnSync('claude', ['--bg', '--resume', s.sessionId, message], { cwd: s.cwd, encoding: 'utf8' });
const text = `${r.stdout}${r.stderr}`;
const sameId = new RegExp(`backgrounded · ${s.id}\\b`).test(text);
console.log(JSON.stringify({ id: s.id, stoppedInMs: Date.now() - t0, sameId, output: text.trim().split('\n').filter((l) => /woke|copy|backgrounded/.test(l)) }, null, 1));
process.exit(sameId ? 0 : 3);
