// Lance une session d'essai en arrière-plan dans le bac à sable, isolée de la configuration de l'utilisateur.
// node spike/launch.js --name <nom> [--settings <fichier>] [--model haiku] [--mode isolated|user|bypass|manual]
//                      [--session-id auto|none] [--agents <json>] [--agent <nom>] [--env K=V]... -- "<consigne>"
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeJson, out } = require('./lib');
const { listSessions } = require('./sessions');

const SPIKE = __dirname;
const SANDBOX = process.env.RL_SANDBOX || path.join(os.homedir(), 'relaylead-sandbox');

function parse(argv) {
  const o = { model: 'haiku', mode: 'isolated', sessionId: 'none', env: {} };
  const sep = argv.indexOf('--');
  o.prompt = sep >= 0 ? argv.slice(sep + 1).join(' ') : '';
  const a = sep >= 0 ? argv.slice(0, sep) : argv;
  for (let i = 0; i < a.length; i += 2) {
    const k = a[i], v = a[i + 1];
    if (k === '--env') { const [ek, ...ev] = v.split('='); o.env[ek] = ev.join('='); }
    else o[k.replace(/^--/, '').replace(/-(.)/g, (_, c) => c.toUpperCase())] = v;
  }
  return o;
}

// Le fichier de réglages porte les chemins (${SPIKE}) et l'environnement des hooks : la session en
// arrière-plan ne garantit pas d'hériter de l'environnement du lanceur.
function sessionSettings(o) {
  const base = o.settings ? fs.readFileSync(path.resolve(o.settings), 'utf8').replaceAll('${SPIKE}', SPIKE) : '{}';
  const s = JSON.parse(base);
  s.env = { ...(s.env || {}), RL_OUT: out(), ...o.env };
  const file = out('settings', `${o.name.replace(/[^\w.-]/g, '_')}.json`);
  writeJson(file, s);
  return file;
}

function main() {
  const o = parse(process.argv.slice(2));
  // --allowedTools prend plusieurs valeurs : placé en dernier, il avale la consigne. On le met en tête.
  const args = [];
  if (o.mode === 'bypass') args.push('--dangerously-skip-permissions');
  else if (o.mode === 'manual') args.push('--permission-mode', 'manual');
  else args.push('--allowedTools', 'Bash(node *)', 'Read', 'Write', 'Edit', '--permission-mode', 'acceptEdits');
  args.push('--bg', '--name', o.name, '--model', o.model, '--settings', sessionSettings(o));
  if (o.mode !== 'user') args.push('--setting-sources', 'project,local', '--strict-mcp-config');
  const wanted = o.sessionId === 'auto' ? crypto.randomUUID() : null;
  if (wanted) args.push('--session-id', wanted);
  if (o.agents) args.push('--agents', o.agents);
  if (o.agent) args.push('--agent', o.agent);
  args.push(o.prompt);
  const r = spawnSync('claude', args, { cwd: SANDBOX, encoding: 'utf8' });
  const text = `${r.stdout}${r.stderr}`;
  const shortId = (text.match(/claude attach ([0-9a-f]+)/) || [])[1] || null;
  const row = listSessions({ all: true }).find((s) => s.id === shortId) || {};
  console.log(JSON.stringify({ name: o.name, code: r.status, shortId, sessionId: row.sessionId || null,
    wanted, sessionIdHonored: wanted ? row.sessionId === wanted : null, output: text.trim().slice(0, 400) }, null, 1));
}

main();
