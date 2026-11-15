// Relève l'état d'une session toutes les 10 s : node spike/watch.js <nom exact> <secondes>
const { listSessions } = require('./sessions');
const { execFileSync } = require('node:child_process');
const [name, secs] = [process.argv[2], Number(process.argv[3] || 60)];
const seen = [];
const t0 = Date.now();
(function tick() {
  const s = listSessions({ all: true }).find((x) => x.name === name);
  seen.push(s ? `${s.state}/${s.status}${s.waitingFor ? '/' + s.waitingFor : ''}` : 'absente');
  if (Date.now() - t0 < secs * 1000 && !(s && s.state === 'done')) setTimeout(tick, 10000);
  else console.log(JSON.stringify({ name, seen, permissionPromptSeen: seen.some((x) => x.includes('permission')) }));
})();
