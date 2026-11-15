const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { writeJson, readJson } = require('../core/store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relaylead-store-'));
}

test('writeJson then readJson round-trips', () => {
  const file = path.join(tmpDir(), 'a', 'b', 'x.json');
  writeJson(file, { a: 1, list: [1, 2] });
  assert.deepStrictEqual(readJson(file), { a: 1, list: [1, 2] });
});

test('readJson returns the fallback for a missing file', () => {
  const file = path.join(tmpDir(), 'missing.json');
  assert.deepStrictEqual(readJson(file, { none: true }), { none: true });
});

test('readJson names the file when JSON is invalid', () => {
  const file = path.join(tmpDir(), 'bad.json');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => readJson(file), (err) => err.message.includes(file));
});

test('concurrent writers never leave a truncated file', async () => {
  const file = path.join(tmpDir(), 'shared.json');
  writeJson(file, { writer: 'init' });
  const helper = path.join(__dirname, '..', 'fixtures', 'writer.js');
  const children = ['a', 'b'].map((label) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, file, label, '200'], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('writer exit ' + code))));
  }));
  let reads = 0;
  let running = true;
  Promise.all(children).then(() => { running = false; });
  while (running || reads < 200) {
    assert.ok(readJson(file).writer); // throws if the file is truncated
    reads++;
    await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(children);
});
