// A fake API server for the trial with Claude Code (lot 2a, Task 13), never used by the product:
// it answers every request with a usage limit, as the API does. Usage: node fixtures/fake-429.js [port]
// Prints the port it listens on (a free one without an argument), on 127.0.0.1 only.
const http = require('node:http');

const port = Number(process.argv[2] || 0);
const RESET_AFTER_S = 3600;

const server = http.createServer((request, response) => {
  request.resume();
  response.writeHead(429, {
    'content-type': 'application/json',
    'retry-after': String(RESET_AFTER_S),
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + RESET_AFTER_S),
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  });
  response.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Rate limit reached (Relaylead fake server)' } }));
});
server.listen(port, '127.0.0.1', () => console.log(server.address().port));
