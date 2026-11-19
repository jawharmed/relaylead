const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { sendMail, readMail, markRead, unreadCount } = require('../core/mailbox');
const { missionDir } = require('../core/paths');
const { tmpDir } = require('../fixtures/helpers');

// A fresh RELAYLEAD_HOME with mission demo's folder, made by the core before any session runs.
function freshMission() {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  fs.mkdirSync(missionDir('demo'), { recursive: true });
}

function mailbox(shortId, ...rest) {
  return path.join(missionDir('demo'), 'mailbox', shortId, ...rest);
}

test('mail is read in the order it was sent, then kept in read/', () => {
  freshMission();
  // Sent in a row: both may get the same millisecond.
  const first = sendMail('demo', '0123abcd', 'first');
  const second = sendMail('demo', '0123abcd', 'second');
  assert.strictEqual(path.dirname(first), mailbox('0123abcd'));
  assert.match(path.basename(first), /^000001-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.md$/);
  assert.match(path.basename(second), /^000002-/);

  const mail = readMail('demo', '0123abcd');
  assert.deepStrictEqual(mail, [
    { file: first, text: 'first' },
    { file: second, text: 'second' },
  ]);
  // Reading moves nothing.
  assert.strictEqual(unreadCount('demo', '0123abcd'), 2);

  markRead('demo', '0123abcd', mail.map((one) => one.file));
  assert.deepStrictEqual(readMail('demo', '0123abcd'), []);
  assert.strictEqual(unreadCount('demo', '0123abcd'), 0);
  assert.deepStrictEqual(fs.readdirSync(mailbox('0123abcd', 'read')).sort(), [path.basename(first), path.basename(second)]);
  assert.strictEqual(fs.readFileSync(mailbox('0123abcd', 'read', path.basename(second)), 'utf8'), 'second');

  // Marked again (a hook killed after its move, then run again): nothing to move, no error.
  markRead('demo', '0123abcd', [first]);
  // The read mail still counts: the next number follows it.
  assert.match(path.basename(sendMail('demo', '0123abcd', 'third')), /^000003-/);
});

test('the mail of one session is not taken by another', () => {
  freshMission();
  sendMail('demo', '0123abcd', 'for the lead');
  assert.deepStrictEqual(readMail('demo', '89abcdef'), []);
  assert.strictEqual(unreadCount('demo', '89abcdef'), 0);
  markRead('demo', '89abcdef', readMail('demo', '89abcdef').map((one) => one.file));
  assert.deepStrictEqual(readMail('demo', '0123abcd').map((one) => one.text), ['for the lead']);
});

test('fifty mails sent in a row all arrive, in order', () => {
  freshMission();
  const texts = Array.from({ length: 50 }, (_, i) => `message ${i + 1}`);
  const files = texts.map((text) => sendMail('demo', '0123abcd', text));

  const names = files.map((file) => path.basename(file));
  assert.strictEqual(new Set(names).size, 50);
  for (let i = 1; i < names.length; i++) assert.ok(names[i - 1] < names[i], `${names[i - 1]} < ${names[i]}`);
  assert.deepStrictEqual(fs.readdirSync(mailbox('0123abcd')).sort(), [...names].sort());
  assert.deepStrictEqual(readMail('demo', '0123abcd').map((one) => one.text), texts);
});
