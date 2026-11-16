const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runFileSync } = require('../core/run-file');
const { tmpDir } = require('../fixtures/helpers');

// A program that writes, starts a background job holding its stdout and stderr, and ends at once.
test('a program that leaves a process behind returns as soon as it ends', { skip: process.platform === 'win32', timeout: 20000 }, (t) => {
  const bin = tmpDir('relaylead-run-');
  const leftover = path.join(bin, 'leftover.pid');
  const program = path.join(bin, 'program');
  fs.writeFileSync(program, `#!/bin/sh\necho out\necho err >&2\nsleep 30 &\necho $! > '${leftover}'\nexit 0\n`, { mode: 0o755 });
  t.after(() => {
    try {
      process.kill(Number(fs.readFileSync(leftover, 'utf8')));
    } catch {
      // already ended
    }
  });

  const startedAt = Date.now();
  const output = runFileSync(program, [], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.strictEqual(output, 'out\n');
  assert.ok(Date.now() - startedAt < 5000, `the call took ${Date.now() - startedAt} ms`);
});

test('a program that fails throws with its exit code and output', () => {
  const script = 'process.stdout.write("partial"); process.stderr.write("broken"); process.exit(3)';
  assert.throws(
    () => runFileSync(process.execPath, ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    (err) => err.status === 3 && err.stdout === 'partial' && err.stderr === 'broken' && /broken/.test(err.message),
  );
});
