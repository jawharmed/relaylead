// Relève l'état d'une session toutes les 10 s : node spike/watch.js <nom exact> <secondes>
const { listSessions } = require('./sessions');
const [name, secs] = [process.argv[2], Number(process.argv[3] || 60)];
const seen = [];
const t0 = Date.now();
(function tick() {
  // Les noms en double sont acceptés (2c) : on suit la session la plus récente de ce nom.
  const s = listSessions({ all: true }).filter((x) => x.name === name).sort((a, b) => b.startedAt - a.startedAt)[0];
  seen.push(s ? `${s.state}/${s.status}${s.waitingFor ? '/' + s.waitingFor : ''}` : 'absente');
  if (Date.now() - t0 < secs * 1000 && !(s && s.state === 'done')) setTimeout(tick, 10000);
  else console.log(JSON.stringify({ name, seen, permissionPromptSeen: seen.some((x) => x.includes('permission')) }));
})();
