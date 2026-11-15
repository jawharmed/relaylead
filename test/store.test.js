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
  const failures = [];
  let running = 2;
  for (const label of ['a', 'b']) {
    const child = spawn(process.execPath, [helper, file, label, '200'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    let finished = false;
    const finish = (problem) => {
      if (finished) return; // 'error' and 'close' can both fire
      finished = true;
      if (problem) failures.push(problem);
      running--;
    };
    child.on('error', (err) => finish(String(err)));
    // 'close' fires after stderr is fully read
    child.on('close', (code) => finish(code === 0 ? null : `writer ${label} exited with ${code}: ${stderr}`));
  }
  // Read while the writers run; stop when they end, fail, or after the deadline.
  const deadline = Date.now() + 30000;
  let reads = 0;
  while ((running > 0 || reads < 200) && failures.length === 0 && Date.now() < deadline) {
    assert.ok(readJson(file).writer); // throws if the file is truncated
    reads++;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepStrictEqual(failures, []);
  assert.ok(running === 0, 'writers did not finish within 30 s');
});
