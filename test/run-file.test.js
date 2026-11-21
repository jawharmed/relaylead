const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runFileSync, needsPipes } = require('../core/run-file');
const { tmpDir } = require('../fixtures/helpers');

// On macOS with libuv < 1.45, the output goes through pipes (issue #53).
const PIPES = needsPipes(process.platform, process.versions.uv);

// A program that writes, starts a background job holding its stdout and stderr, and ends at once.
// The background job is killed after the test.
function lingeringProgram(t) {
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
  return program;
}

const skipLingering = process.platform === 'win32' || (PIPES && 'pipes stay open until the timeout on macOS with libuv < 1.45');
test('a program that leaves a process behind returns as soon as it ends', { skip: skipLingering, timeout: 20000 }, (t) => {
  const program = lingeringProgram(t);
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

// libuv before 1.45 on macOS may miss the end of a fast child when no pipe is open (issue #53).
test('pipes are needed only on macOS with a libuv older than 1.45', () => {
  assert.strictEqual(needsPipes('darwin', '1.44.2'), true);
  assert.strictEqual(needsPipes('darwin', '1.45.0'), false);
  assert.strictEqual(needsPipes('darwin', '1.51.0'), false);
  assert.strictEqual(needsPipes('linux', '1.44.2'), false);
  assert.strictEqual(needsPipes('win32', '1.44.2'), false);
});

test('with pipes, a program that leaves a process behind is stopped at the timeout', { skip: !PIPES && 'only on macOS with libuv < 1.45', timeout: 20000 }, (t) => {
  const program = lingeringProgram(t);
  const startedAt = Date.now();
  assert.throws(() => runFileSync(program, [], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 1000 }), (err) => err.code === 'ETIMEDOUT');
  assert.ok(Date.now() - startedAt < 5000, `the call took ${Date.now() - startedAt} ms`);
});

test('a text input reaches the program, whichever way the output is read', () => {
  const script = 'process.stdin.pipe(process.stdout)';
  assert.strictEqual(runFileSync(process.execPath, ['-e', script], { input: '{"a":1}', encoding: 'utf8' }), '{"a":1}');
});
