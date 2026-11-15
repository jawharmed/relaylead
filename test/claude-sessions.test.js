const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseLaunchOutput, mapState } = require('../adapters/claude/sessions');

const fixture = (name) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'claude', name), 'utf8');

test('parses the short id, a copy and an untrusted folder from recorded outputs', () => {
  assert.deepStrictEqual(parseLaunchOutput(fixture('launch-ok.txt')), { shortId: '0f0b2950' });
  assert.deepStrictEqual(parseLaunchOutput(fixture('launch-ok-colour-crlf.txt')), { shortId: '7764803b' });
  assert.deepStrictEqual(parseLaunchOutput(fixture('launch-copy.txt')), { shortId: '9c1d2e3f', copyOf: '0f0b2950' });
  assert.deepStrictEqual(parseLaunchOutput(fixture('launch-untrusted.txt')), { error: 'untrusted-dir' });
  assert.deepStrictEqual(parseLaunchOutput(fixture('launch-unknown.txt')), { error: 'unknown' });
  assert.deepStrictEqual(parseLaunchOutput(''), { error: 'unknown' });
});

test('maps claude states', () => {
  const rows = JSON.parse(fixture('agents-states.json'));
  const sessions = rows.map(mapState);
  assert.deepStrictEqual(sessions.map((s) => s.state), ['working', 'waiting', 'done', 'stopped', 'failed']);
  assert.deepStrictEqual(sessions[0], {
    sessionId: '0f0b2950-1111-4222-8333-444455556666',
    shortId: '0f0b2950',
    name: 'demo/lead/1',
    role: 'lead',
    state: 'working',
    pid: 4242,
    cwd: '/work/demo',
  });
  assert.strictEqual(sessions[1].role, 'crew');
  assert.strictEqual(sessions[3].pid, null);
  assert.strictEqual(sessions[4].pid, null);
});
