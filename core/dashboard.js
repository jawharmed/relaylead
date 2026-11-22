// `relaylead dashboard`: a local web page that shows the missions (core/overview.js) and lets the user
// answer a question or stop a mission. The server listens on 127.0.0.1 only. Reading is open to the
// page itself; answering and stopping need the token made for this launch, which only the page we serve
// carries: another site open in the browser cannot read it (no CORS header) nor guess it. The Host
// header is checked too, against DNS rebinding.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { buildOverview } = require('./overview');
const { codedError } = require('./messages');

const PAGE = path.join(__dirname, 'dashboard-page.html');
const BODY_MAX = 10 * 1024;
const NAME = /^[A-Za-z0-9-]+$/;

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function sameToken(given, token) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

function sendJson(res, status, data) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', (chunk) => {
      text += chunk;
      if (text.length > BODY_MAX) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(text));
    req.on('error', reject);
  });
}

// `actions` is { answer(mission, id, choice), stop(mission) }, each resolving to { ok, message }.
// `port` 0 takes any free port. Resolves to { server, url, token }.
function startDashboard({ port, actions }) {
  const token = newToken();
  const page = fs.readFileSync(PAGE, 'utf8').replace('__TOKEN__', token);
  let origin = '';
  const hosts = () => [`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`];

  async function handle(req, res) {
    if (!hosts().includes(req.headers.host)) return sendJson(res, 403, { error: 'bad host' });
    if (req.method === 'GET' && req.url === '/') return send(res, 200, 'text/html; charset=utf-8', page);
    if (req.url === '/favicon.ico') return send(res, 204, 'image/x-icon', '');
    if (req.method === 'GET' && req.url === '/api/overview') return sendJson(res, 200, buildOverview());
    if (req.method !== 'POST' || !['/api/answer', '/api/stop'].includes(req.url)) return sendJson(res, 404, { error: 'not found' });

    // The page sends Origin on every POST; a request without the token or from another origin is refused.
    if (!sameToken(req.headers['x-relaylead-token'], token)) return sendJson(res, 403, { error: 'bad token' });
    if (req.headers.origin && req.headers.origin !== origin && req.headers.origin !== origin.replace('127.0.0.1', 'localhost')) {
      return sendJson(res, 403, { error: 'bad origin' });
    }
    let data;
    try {
      data = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'bad body' });
    }
    if (!NAME.test(String(data.mission)) || (req.url === '/api/answer' && (!NAME.test(String(data.id)) || data.choice === undefined))) {
      return sendJson(res, 400, { error: 'bad request' });
    }
    const result = req.url === '/api/answer' ? await actions.answer(data.mission, data.id, data.choice) : await actions.stop(data.mission);
    return sendJson(res, result.ok ? 200 : 409, result);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => sendJson(res, 500, { error: 'failed' }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', (err) => reject(err.code === 'EADDRINUSE' ? codedError('dashboard-port-busy', { port }) : err));
    server.listen(port, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, url: origin, token });
    });
  });
}

module.exports = { startDashboard };
