// Outils partagés de l'essai jetable : transcripts, écriture atomique, lecture de l'entrée des hooks.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function findTranscript(sessionId) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(root)) return null;
  for (const dir of fs.readdirSync(root)) {
    const f = path.join(root, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// Contexte utilisé = jetons d'entrée de la dernière réponse du fil principal (cache compris).
function contextTokens(transcriptPath) {
  const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (e.type !== 'assistant' || e.isSidechain || !e.message?.usage) continue;
    const u = e.message.usage;
    const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    return { tokens, model: e.message.model, at: e.timestamp };
  }
  return null;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function readStdinJson() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

const out = (...p) => path.join(process.env.RL_OUT || path.join(__dirname, 'out'), ...p);

module.exports = { findTranscript, contextTokens, writeJson, readStdinJson, out };
