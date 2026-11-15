// Barre d'état de mesure : écrit ce que Claude Code lui transmet, sans rien afficher d'utile.
const { readStdinJson, writeJson, out } = require('./lib');
readStdinJson().then((j) => {
  if (j.session_id) writeJson(out('statusline', `${j.session_id}.json`), {
    at: new Date().toISOString(), context_window: j.context_window, rate_limits: j.rate_limits,
    model: j.model, env: process.env.RL_MISSION || null });
  console.log('rl-probe');
});
