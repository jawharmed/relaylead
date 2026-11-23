const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { writeJson, writeText, writeTextExclusive, readJson, writeRetryMs } = require('../core/store');

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

test('writeTextExclusive refuses a file that exists', () => {
  const file = path.join(tmpDir(), 'mail', 'one.md');
  assert.strictEqual(writeTextExclusive(file, 'first'), true);
  assert.strictEqual(writeTextExclusive(file, 'second'), false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'first');
  // No temporary file is left behind, written or refused.
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['one.md']);
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

test('the Windows write retry budget follows RELAYLEAD_WRITE_RETRY_MS', (t) => {
  const saved = process.env.RELAYLEAD_WRITE_RETRY_MS;
  t.after(() => {
    if (saved === undefined) delete process.env.RELAYLEAD_WRITE_RETRY_MS;
    else process.env.RELAYLEAD_WRITE_RETRY_MS = saved;
  });
  process.env.RELAYLEAD_WRITE_RETRY_MS = '500';
  assert.strictEqual(writeRetryMs(), 500);
  process.env.RELAYLEAD_WRITE_RETRY_MS = '0';
  assert.strictEqual(writeRetryMs(), 0);
  delete process.env.RELAYLEAD_WRITE_RETRY_MS;
  assert.strictEqual(writeRetryMs(), 2000);
  process.env.RELAYLEAD_WRITE_RETRY_MS = 'abc';
  assert.strictEqual(writeRetryMs(), 2000);
});

test('a failing temporary file removal does not hide the write error', (t) => {
  const realRename = fs.renameSync;
  const realRm = fs.rmSync;
  t.after(() => {
    fs.renameSync = realRename;
    fs.rmSync = realRm;
  });
  fs.renameSync = () => {
    throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
  };
  fs.rmSync = () => {
    throw Object.assign(new Error('busy'), { code: 'EBUSY' });
  };
  assert.throws(() => writeJson(path.join(tmpDir(), 'x.json'), { a: 1 }), (err) => err.code === 'EXDEV');
});

test('writeText sets the mode despite the umask', { skip: process.platform === 'win32' }, (t) => {
  const oldMask = process.umask(0o077);
  t.after(() => process.umask(oldMask));
  const file = path.join(tmpDir(), 'run.sh');
  writeText(file, '#!/bin/sh\n', { mode: 0o755 });
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o755);
});

// --- Permissions (lot H1) ---------------------------------------------------------------------

const { appendText, secureHome } = require('../core/store');
const modeOf = (file) => fs.statSync(file).mode & 0o777;

// RELAYLEAD_HOME set to a folder not made yet, for the rest of test `t`.
function useNewHome(t) {
  const home = path.join(tmpDir(), 'home');
  const previous = process.env.RELAYLEAD_HOME;
  process.env.RELAYLEAD_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.RELAYLEAD_HOME;
    else process.env.RELAYLEAD_HOME = previous;
  });
  return home;
}

test('under RELAYLEAD_HOME, folders are made in 700 and files in 600', { skip: process.platform === 'win32' }, (t) => {
  const home = useNewHome(t);
  const previousMask = process.umask(0o022);
  t.after(() => process.umask(previousMask));
  writeJson(path.join(home, 'missions', 'demo', 'state.json'), { state: 'working' });
  writeTextExclusive(path.join(home, 'missions', 'demo', 'mail', 'one.md'), 'hello');
  appendText(path.join(home, 'watch.log'), 'line\n');
  assert.strictEqual(modeOf(home), 0o700);
  assert.strictEqual(modeOf(path.join(home, 'missions', 'demo')), 0o700);
  assert.strictEqual(modeOf(path.join(home, 'missions', 'demo', 'state.json')), 0o600);
  assert.strictEqual(modeOf(path.join(home, 'missions', 'demo', 'mail', 'one.md')), 0o600);
  assert.strictEqual(modeOf(path.join(home, 'watch.log')), 0o600);
  // A mode given by the caller wins (the mission's relaylead shim is run by the sessions).
  writeText(path.join(home, 'missions', 'demo', 'bin', 'relaylead'), '#!/bin/sh\n', { mode: 0o755 });
  assert.strictEqual(modeOf(path.join(home, 'missions', 'demo', 'bin', 'relaylead')), 0o755);
  // Elsewhere (the project memory, the plist), the usual modes.
  const outside = path.join(tmpDir(), 'project', 'memory.md');
  writeText(outside, 'notes\n');
  assert.strictEqual(modeOf(outside), 0o644);
});

test('secureHome puts a home readable by others back in 700', { skip: process.platform === 'win32' }, (t) => {
  const home = useNewHome(t);
  assert.strictEqual(secureHome(), null, 'nothing to do when the folder does not exist');
  fs.mkdirSync(home, { mode: 0o755 });
  fs.chmodSync(home, 0o755);
  assert.strictEqual(secureHome(), '755');
  assert.strictEqual(modeOf(home), 0o700);
  assert.strictEqual(secureHome(), null);
});
