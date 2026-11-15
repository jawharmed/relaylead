// Faux serveur d'API qui répond toujours 429 (limite d'usage) : node spike/fake-429.js <port>
// Chaque requête reçue est notée dans RL_OUT/fake-429.log (méthode, chemin, en-têtes utiles).
const http = require('node:http');
const fs = require('node:fs');
const { out } = require('./lib');
const port = Number(process.argv[2] || 0);
const reset = Math.floor(Date.now() / 1000) + 3600;
http.createServer((req, res) => {
  req.resume();
  fs.appendFileSync(out('fake-429.log'), `${new Date().toISOString()} ${req.method} ${req.url} auth=${req.headers.authorization ? 'bearer' : req.headers['x-api-key'] ? 'api-key' : 'aucune'}\n`);
  res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3600',
    'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': String(reset),
    'anthropic-ratelimit-unified-representative-claim': 'five_hour' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limit reached (essai Relaylead)' } }));
}).listen(port, '127.0.0.1', function () { console.log(this.address().port); });
