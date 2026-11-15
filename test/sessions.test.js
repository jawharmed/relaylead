const test = require('node:test');
const assert = require('node:assert');
const { recordSession, listSessions } = require('../core/sessions');
const { tmpDir } = require('../fixtures/helpers');

function session(sessionId, state) {
  return { sessionId, shortId: 'abcd1234', name: 'demo/lead/1', role: 'lead', state, pid: null, cwd: '.' };
}

test('recordSession refuses to overwrite another session with the same short id', () => {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  recordSession('demo', session('fake-abcd1234aaaaaaaa', 'working'));
  recordSession('demo', session('fake-abcd1234aaaaaaaa', 'done'));
  assert.throws(
    () => recordSession('demo', session('fake-abcd1234bbbbbbbb', 'working')),
    (err) => err.code === 'session-exists',
  );
  assert.deepStrictEqual(
    listSessions('demo').map((s) => [s.sessionId, s.state]),
    [['fake-abcd1234aaaaaaaa', 'done']],
  );
});
