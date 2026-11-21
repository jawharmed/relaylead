// The notifications go to a script of fixtures/ in place of osascript (RELAYLEAD_NOTIFY_BIN), which
// writes down the arguments it was given.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, waitFor } = require('../fixtures/helpers');
const { notify } = require('../core/notify');
const { askQuestion } = require('../core/questions');

const BIN = path.join(__dirname, '..', 'fixtures', 'notify-bin.js');

// Notifications on, sent to the script; returns a function giving the calls received so far.
function recordNotifications(t) {
  const log = path.join(tmpDir(), 'notifications.log');
  const names = ['RELAYLEAD_NOTIFY', 'RELAYLEAD_NOTIFY_BIN', 'RELAYLEAD_NOTIFY_LOG'];
  const saved = names.map((name) => process.env[name]);
  t.after(() => {
    names.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    });
  });
  delete process.env.RELAYLEAD_NOTIFY;
  process.env.RELAYLEAD_NOTIFY_BIN = BIN;
  process.env.RELAYLEAD_NOTIFY_LOG = log;
  return () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('notify passes the text and the title to osascript, without quotes or backslashes', async (t) => {
  const calls = recordNotifications(t);
  notify({ title: 'Relaylead: demo', text: 'Run "git reset --hard" \\ now?' });
  await waitFor(() => calls().length === 1, 5000, 'the notification');
  assert.deepStrictEqual(calls(), [['-e', 'display notification "Run git reset --hard  now?" with title "Relaylead: demo"']]);
});

test('a new question notifies, the same question asked again does not', async (t) => {
  const calls = recordNotifications(t);
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  const question = { key: 'db', text: 'Which database?', options: ['sqlite', 'postgres'] };
  askQuestion('demo', question);
  await waitFor(() => calls().length === 1, 5000, 'the notification');
  assert.match(calls()[0][1], /^display notification "Question q-db: Which database\?" with title "Relaylead: demo"$/);
  askQuestion('demo', question);
  await pause(500);
  assert.strictEqual(calls().length, 1);
});

test('RELAYLEAD_NOTIFY=off sends nothing', async (t) => {
  const calls = recordNotifications(t);
  process.env.RELAYLEAD_NOTIFY = 'off';
  notify({ title: 'Relaylead: demo', text: 'nothing' });
  await pause(500);
  assert.deepStrictEqual(calls(), []);
});
