const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { startDashboard } = require('../core/dashboard');
const { run } = require('../core/cli');
const { askQuestion, listQuestions } = require('../core/questions');
const { makeIo } = require('../fixtures/helpers');
const { setupProject, writeMission } = require('../fixtures/missions');

// A request with the Host header a browser would send, unless the test sets another.
function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({ host: '127.0.0.1', port: target.port, path: target.pathname, method, headers: { Host: target.host, ...headers } }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function start(t) {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  askQuestion('demo', { key: 'db', text: 'Which database?', options: ['sqlite', 'postgres'] });
  const actions = {
    answer: async (mission, id, choice) => {
      const code = await run(['answer', mission, id, String(choice)], makeIo());
      return { ok: code === 0, message: '' };
    },
    answerOther: async (mission, id, text) => {
      const code = await run(['answer', mission, id, '--other', text], makeIo());
      return { ok: code === 0, message: '' };
    },
    stop: async () => ({ ok: true, message: '' }),
  };
  const dashboard = await startDashboard({ port: 0, actions });
  t.after(() => dashboard.server.close());
  return dashboard;
}

test('the page is served with a token, on 127.0.0.1 only, and the overview is readable', async (t) => {
  const { server, url, token } = await start(t);
  assert.strictEqual(server.address().address, '127.0.0.1');
  const page = await request(url + '/');
  assert.strictEqual(page.status, 200);
  assert.ok(page.text.includes(token));
  assert.strictEqual(page.headers['x-frame-options'], 'DENY');
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.ok(!page.text.includes('__TOKEN__'));
  const overview = JSON.parse((await request(url + '/api/overview')).text);
  assert.strictEqual(overview.missions[0].questions[0].id, 'q-db');
});

test('a request with another Host is refused', async (t) => {
  const { url } = await start(t);
  const page = await request(url + '/', { headers: { Host: 'evil.example:80' } });
  assert.strictEqual(page.status, 403);
});

test('an answer without the token, or from another origin, is refused; with the token it is recorded', async (t) => {
  const { url, token } = await start(t);
  const body = JSON.stringify({ mission: 'demo', id: 'q-db', choice: 2 });
  const json = { 'Content-Type': 'application/json' };

  const without = await request(url + '/api/answer', { method: 'POST', headers: json, body });
  assert.strictEqual(without.status, 403);
  const wrong = await request(url + '/api/answer', { method: 'POST', headers: { ...json, 'X-Relaylead-Token': 'nope' }, body });
  assert.strictEqual(wrong.status, 403);
  const foreign = await request(url + '/api/answer', { method: 'POST', headers: { ...json, 'X-Relaylead-Token': token, Origin: 'https://evil.example' }, body });
  assert.strictEqual(foreign.status, 403);
  assert.strictEqual(listQuestions('demo', { state: 'open' }).length, 1);

  const accepted = await request(url + '/api/answer', { method: 'POST', headers: { ...json, 'X-Relaylead-Token': token, Origin: url }, body });
  assert.strictEqual(accepted.status, 200);
  assert.strictEqual(listQuestions('demo', { state: 'answered' })[0].answer.choice, 'postgres');
});

test('a free answer needs the token, is refused for the questions of the hooks, and is recorded otherwise', async (t) => {
  const { url, token } = await start(t);
  askQuestion('demo', { key: 'irr-x', text: 'Allow?', options: ['yes', 'no'], kind: 'irreversible' });
  const headers = { 'Content-Type': 'application/json', 'X-Relaylead-Token': token, Origin: url };
  const post = (data, extra = {}) => request(url + '/api/answer', { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(data) });

  assert.strictEqual((await post({ mission: 'demo', id: 'q-db', other: 'mysql' }, { 'X-Relaylead-Token': 'nope' })).status, 403);
  assert.strictEqual((await post({ mission: 'demo', id: 'q-irr-x', other: 'sure' })).status, 400);
  assert.strictEqual((await post({ mission: 'demo', id: 'q-db', other: '  ' })).status, 400);
  assert.strictEqual((await post({ mission: 'demo', id: 'q-db', choice: 1, other: 'mysql' })).status, 400);
  assert.strictEqual((await post({ mission: 'demo', id: 'q-db', other: 'mysql' })).status, 200);
  const answer = listQuestions('demo', { state: 'answered' })[0].answer;
  assert.deepStrictEqual([answer.choice, answer.other], ['mysql', true]);
});
