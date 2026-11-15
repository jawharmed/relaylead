// Compare la mesure de la statusline (context_window) au calcul sur le transcript.
// node spike/compare.js <sessionId>
const fs = require('node:fs');
const { findTranscript, contextTokens, out } = require('./lib');
const id = process.argv[2];
const probe = JSON.parse(fs.readFileSync(out('statusline', `${id}.json`), 'utf8'));
const t = findTranscript(id);
const calc = t ? contextTokens(t) : null;
const cw = probe.context_window || {};
const u = cw.current_usage || {};
const sl = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
const size = cw.context_window_size;
console.log(JSON.stringify({ at: probe.at, env: probe.env, model: probe.model && probe.model.id, size,
  statusline: sl, used_percentage: cw.used_percentage, total_input_tokens: cw.total_input_tokens,
  transcript: calc && calc.tokens, ecartPctFenetre: calc && size ? +(100 * Math.abs(sl - calc.tokens) / size).toFixed(3) : null,
  rate_limits: probe.rate_limits }));
