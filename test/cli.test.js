const test = require('node:test');
const assert = require('node:assert');
const { run, commands } = require('../core/cli');
const pkg = require('../package.json');
const { tmpDir } = require('../fixtures/helpers');

// A writable-like object that keeps everything written to it.
function capture() {
  return {
    text: '',
    write(chunk) {
      this.text += chunk;
    },
  };
}

function makeIo(env = {}) {
  return { out: capture(), err: capture(), env, cwd: process.cwd() };
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

test('answer, stop and launch are refused from inside a mission session', async () => {
  const env = { RELAYLEAD_MISSION: 'demo' };
  await assert.rejects(commands.answer(['demo', 'q-a', '1'], makeIo(env)), { code: 'not-from-a-session' });
  await assert.rejects(commands.stop(['demo'], makeIo(env)), { code: 'not-from-a-session' });
  await assert.rejects(commands.launch(['--agent', 'fake'], makeIo(env)), { code: 'not-from-a-session' });
  const io = makeIo(env);
  assert.strictEqual(await run(['stop', 'demo'], io), 1);
  assert.match(io.err.text, /relaylead stop/);
});

test('a crew member finishes only its own task and drives no task', async () => {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  const env = { RELAYLEAD_MISSION: 'demo', RELAYLEAD_TASK: 'a' };
  for (const action of ['done', 'fail']) {
    await assert.rejects(commands.task([action, 'b'], makeIo(env)), { code: 'not-your-task', vars: { own: 'a', id: 'b' } });
  }
  for (const action of ['start', 'deliver']) {
    await assert.rejects(commands.task([action, 'a'], makeIo(env)), { code: 'not-for-crew' });
  }
  // Its own task goes on to the mission, which does not exist here.
  await assert.rejects(commands.task(['done', 'a'], makeIo(env)), { code: 'mission-unknown' });
});
