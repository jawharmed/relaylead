const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { takeOverStaleLock } = require('../core/mission-lock');
const { tmpDir } = require('../fixtures/helpers');

function lockIn(dir) {
  const file = path.join(dir, 'demo.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, command: 'old' }));
  return file;
}

test('a takeover that finds the lock no longer stale under the guard keeps it', async () => {
  const file = lockIn(tmpDir());

  const taken = await takeOverStaleLock(file, () => false);

  assert.strictEqual(taken, false);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).command, 'old');
  assert.strictEqual(fs.existsSync(file + '.takeover'), false);
});

test('a takeover checks that the lock is stale while it holds the guard', async () => {
  const file = lockIn(tmpDir());
  let guardHeld = null;

  const taken = await takeOverStaleLock(file, () => {
    guardHeld = fs.existsSync(file + '.takeover');
    return true;
  });

  assert.strictEqual(guardHeld, true);
  assert.strictEqual(taken, true);
  assert.strictEqual(fs.existsSync(file), false);
  assert.strictEqual(fs.existsSync(file + '.takeover'), false);
});

test('a takeover does not check the lock while another taker holds the guard', async () => {
  const file = lockIn(tmpDir());
  fs.writeFileSync(file + '.takeover', JSON.stringify({ pid: process.pid, command: 'takeover' }));
  let checked = false;

  const taken = await takeOverStaleLock(file, () => {
    checked = true;
    return true;
  });

  assert.strictEqual(taken, false);
  assert.strictEqual(checked, false);
  assert.strictEqual(fs.existsSync(file), true);
  assert.strictEqual(fs.existsSync(file + '.takeover'), true);
});
