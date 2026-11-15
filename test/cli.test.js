const test = require('node:test');
const assert = require('node:assert');
const { run } = require('../core/cli');
const pkg = require('../package.json');

// A writable-like object that keeps everything written to it.
function capture() {
  return {
    text: '',
    write(chunk) {
      this.text += chunk;
    },
  };
}

function makeIo() {
  return { out: capture(), err: capture(), env: {}, cwd: process.cwd() };
}

test('prints the version', async () => {
  const io = makeIo();
  const code = await run(['--version'], io);
  assert.strictEqual(code, 0);
  assert.strictEqual(io.out.text.trim(), pkg.version);
});

test('unknown command exits 2 with help', async () => {
  const io = makeIo();
  const code = await run(['frobnicate'], io);
  assert.strictEqual(code, 2);
  assert.match(io.err.text, /frobnicate/);
  assert.match(io.err.text, /launch/);
});

test('help lists the commands', async () => {
  const io = makeIo();
  const code = await run(['--help'], io);
  assert.strictEqual(code, 0);
  for (const name of ['launch', 'list', 'show', 'stop', 'task', 'state', 'wait', 'question', 'answer']) {
    assert.ok(io.out.text.includes(name), `help should mention ${name}`);
  }
});
