const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const claude = require('../adapters/claude');
const { recordSession, isAlive } = require('../core/sessions');
const { missionDir } = require('../core/paths');
const { writeJson } = require('../core/store');
const { tmpDir, waitFor } = require('../fixtures/helpers');

const FAKE = path.join(__dirname, '..', 'fixtures', 'claude', 'fake-claude.js');
const PROFILE = { name: 'developer', model: 'sonnet', effort: 'low', tools: ['Read', 'Edit'], instructions: 'Be brief.' };
const ENV_KEYS = [
  'RELAYLEAD_HOME', 'RELAYLEAD_CLAUDE', 'RELAYLEAD_CLAUDE_START_MS', 'RELAYLEAD_CLAUDE_WAKE_MS',
  'RELAYLEAD_CLAUDE_COMMAND_MS', 'RELAYLEAD_CLAUDE_LAUNCH_MS', 'RELAYLEAD_CLAUDE_WAKE_SETTLE_MS',
  'FAKE_CLAUDE_STATE', 'FAKE_CLAUDE_SCENARIO',
];

// Fresh home, project folder and fake claude state. After the test, every process the fake started
// is asked to end through its stop-all file, never killed by pid (a pid that has ended may belong to
// another test's process by then), and the environment is put back.
function setup(t, scenario = 'normal') {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const state = tmpDir('relaylead-fake-claude-');
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  process.env.RELAYLEAD_CLAUDE = FAKE;
  process.env.FAKE_CLAUDE_STATE = state;
  process.env.FAKE_CLAUDE_SCENARIO = scenario;
  const dir = fs.realpathSync.native(tmpDir('relaylead project '));
  writeJson(path.join(missionDir('demo'), 'mission.json'), { name: 'demo', dir, agent: 'claude', config: { attribution: null } });
  t.after(() => {
    fs.writeFileSync(path.join(state, 'stop-all'), '');
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  return { dir, state };
}

function fakeSessions(state) {
  try {
    return JSON.parse(fs.readFileSync(path.join(state, 'sessions.json'), 'utf8'));
  } catch {
    return [];
  }
}

// Whether this sleeper of the fake claude has ended: it writes its ended file as it exits.
function sleeperEnded(state, sleeper) {
  return fs.existsSync(path.join(state, `ended-${sleeper}`));
}

function calls(state) {
  return fs.readFileSync(path.join(state, 'calls.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function spec(dir, overrides) {
  return {
    mission: 'demo',
    name: 'demo/developer/1',
    role: 'crew',
    profile: PROFILE,
    prompt: 'Write the first file.',
    cwd: dir,
    env: {},
    permissionMode: 'allowlist',
    ...overrides,
  };
}

test('launch returns the session read from agents --json', async (t) => {
  const { dir, state } = setup(t);
  const session = await claude.launch(spec(dir, { env: { RELAYLEAD_TASK: 'a' } }));
  const row = fakeSessions(state)[0];
  assert.deepStrictEqual(session, {
    sessionId: row.sessionId,
    shortId: row.id,
    name: 'demo/developer/1',
    role: 'crew',
    state: 'working',
    pid: row.pid,
    cwd: dir,
  });
  const launchArgs = calls(state).find((args) => args.includes('--bg'));
  const settingsFile = path.join(missionDir('demo'), 'settings', 'demo-developer-1.json');
  assert.strictEqual(launchArgs[launchArgs.indexOf('--settings') + 1], settingsFile);
  // The session gets its environment from the settings: the launcher's environment does not reach it.
  assert.strictEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).env.RELAYLEAD_TASK, 'a');
  assert.strictEqual(launchArgs[launchArgs.length - 1], 'Write the first file.');
});

// claude may list a session as started before it lists its pid: the registry needs that pid when
// `claude agents` fails.
test('launch waits for the pid of a session listed as started without one', async (t) => {
  const { dir, state } = setup(t, 'pid-late');
  const session = await claude.launch(spec(dir));
  assert.ok(session.pid, 'the session should have its pid');
  assert.strictEqual(session.pid, fakeSessions(state)[0].pid);

  // A pid that never comes does not fail the launch, once the row has been read again for it.
  process.env.FAKE_CLAUDE_SCENARIO = 'pid-never';
  process.env.RELAYLEAD_CLAUDE_START_MS = '1000';
  const before = calls(state).length;
  const withoutPid = await claude.launch(spec(dir, { name: 'demo/developer/2' }));
  assert.deepStrictEqual([withoutPid.state, withoutPid.pid], ['working', null]);
  assert.ok(calls(state).slice(before).filter((args) => args[0] === 'agents').length >= 2);
});

// The session has started: a list that fails while its pid is awaited does not undo the launch.
test('a list that fails while the pid is awaited keeps the session started', async (t) => {
  const { dir, state } = setup(t, 'pid-never,agents-fail-after-one');
  const session = await claude.launch(spec(dir));
  assert.deepStrictEqual([session.state, session.pid], ['working', null]);
  assert.strictEqual(fakeSessions(state)[0].state, 'working');
  assert.ok(!calls(state).some((args) => args[0] === 'stop'), 'the session should not be stopped');
});

// Busy in a state this version does not know: started, so its pid is awaited too.
test('launch waits for the pid of a busy session in an unknown state', async (t) => {
  const { dir, state } = setup(t, 'unknown-state-busy,pid-late');
  const session = await claude.launch(spec(dir));
  assert.strictEqual(session.pid, fakeSessions(state)[0].pid);
  assert.ok(session.pid, 'the session should have its pid');
});

test('list keeps the mission sessions; stop and attach use the short id', async (t) => {
  const { dir, state } = setup(t);
  const mine = await claude.launch(spec(dir));
  // Launched but not in the registry: not one of the mission's sessions.
  await claude.launch(spec(dir, { name: 'demo/developer/2' }));
  recordSession('demo', mine);

  assert.deepStrictEqual((await claude.list('demo')).map((s) => [s.shortId, s.state, s.idle]), [[mine.shortId, 'working', false]]);
  assert.strictEqual(await claude.attach(mine), 0);
  await claude.stop(mine);
  await claude.stop(mine);
  assert.deepStrictEqual((await claude.list('demo')).map((s) => s.state), ['stopped']);
  // Stopping a session claude no longer knows ("No job matching", exit 1) is not an error.
  await claude.stop({ ...mine, shortId: 'deadbeef' });
  assert.deepStrictEqual(calls(state).filter((args) => args[0] !== 'agents' && !args.includes('--bg')).slice(-4), [
    ['attach', mine.shortId],
    ['stop', mine.shortId],
    ['stop', mine.shortId],
    ['stop', 'deadbeef'],
  ]);
});

test('stop ends the session process and kills nothing by its pid', async (t) => {
  const { dir, state } = setup(t);
  const session = await claude.launch(spec(dir));
  const [{ sleeper }] = fakeSessions(state);
  // The row's pid now names an unrelated live process, as when Windows has given it to another one.
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => unrelated.kill());
  writeJson(path.join(state, 'sessions.json'), fakeSessions(state).map((row) => ({ ...row, pid: unrelated.pid })));

  await claude.stop(session);
  await waitFor(() => sleeperEnded(state, sleeper), 10000, 'the session process to end');
  // A child of this test that has not ended: its pid is still its own.
  assert.ok(isAlive(unrelated.pid));
});

test('list says a session is idle from its status, and keeps its state', async (t) => {
  const { dir } = setup(t, 'working-idle');
  const session = await claude.launch(spec(dir));
  recordSession('demo', session);
  assert.deepStrictEqual((await claude.list('demo')).map((s) => [s.state, s.idle]), [['working', true]]);
});

test('list asks claude nothing when the mission has no session', async (t) => {
  const { state } = setup(t);
  assert.deepStrictEqual(await claude.list('demo'), []);
  assert.strictEqual(fs.existsSync(path.join(state, 'calls.log')), false);
});

test('reads the JSON and the version from stdout only', async (t) => {
  const { dir } = setup(t, 'noisy');
  const session = await claude.launch(spec(dir));
  recordSession('demo', session);
  assert.deepStrictEqual((await claude.list('demo')).map((s) => s.shortId), [session.shortId]);
});

test('a claude command that does not answer times out', { timeout: 20000 }, async (t) => {
  const { dir } = setup(t);
  const session = await claude.launch(spec(dir));
  recordSession('demo', session);
  process.env.FAKE_CLAUDE_SCENARIO = 'hang-agents';
  process.env.RELAYLEAD_CLAUDE_COMMAND_MS = '500';
  await assert.rejects(claude.list('demo'), (err) => {
    assert.strictEqual(err.code, 'claude-timeout');
    assert.ok(err.message.includes('claude agents --json --all'), err.message);
    return true;
  });
});

test('a stop that fails on a running session is an error', async (t) => {
  const { dir } = setup(t, 'unstoppable');
  const session = await claude.launch(spec(dir));
  await assert.rejects(claude.stop(session), (err) => {
    assert.strictEqual(err.code, 'claude-failed');
    assert.match(err.message, /did not answer/);
    return true;
  });
});

test('a stop that fails on a done session with a live process is an error', async (t) => {
  const { dir } = setup(t, 'done-at-launch,unstoppable');
  const session = await claude.launch(spec(dir));
  assert.strictEqual(session.state, 'done');
  await assert.rejects(claude.stop(session), { code: 'claude-failed' });
});

test('refuses a .cmd or .bat claude', async (t) => {
  const { dir } = setup(t);
  process.env.RELAYLEAD_CLAUDE = path.join(dir, 'claude.cmd');
  await assert.rejects(claude.launch(spec(dir)), { code: 'claude-cmd-unsupported' });
  process.env.RELAYLEAD_CLAUDE = path.join(dir, 'claude.BAT');
  await assert.rejects(claude.launch(spec(dir)), { code: 'claude-cmd-unsupported' });
});

test('refuses a prompt or a wake message claude would read as an option', async (t) => {
  const { dir, state } = setup(t);
  await assert.rejects(claude.launch(spec(dir, { prompt: '--help' })), { code: 'bad-prompt' });
  assert.deepStrictEqual(fakeSessions(state), []);
  const session = await claude.launch(spec(dir));
  await assert.rejects(claude.wake(session, '-x'), { code: 'bad-prompt' });
  assert.strictEqual(calls(state).filter((args) => args[0] === 'stop').length, 0);
});

test('refuses an old claude version', async (t) => {
  const { dir, state } = setup(t, 'old-version');
  // Another path to the same fake: the version found is cached per command.
  const oldClaude = path.join(state, 'old-claude.js');
  fs.writeFileSync(oldClaude, `require(${JSON.stringify(FAKE)});\n`);
  process.env.RELAYLEAD_CLAUDE = oldClaude;
  await assert.rejects(claude.launch(spec(dir)), (err) => {
    assert.strictEqual(err.code, 'claude-too-old');
    assert.match(err.message, /2\.1\.300/);
    assert.match(err.message, /2\.1\.325/);
    return true;
  });
  assert.deepStrictEqual(fakeSessions(state), []);
});

test('reports an untrusted folder with the fix', async (t) => {
  const { dir } = setup(t, 'untrusted');
  await assert.rejects(claude.launch(spec(dir)), (err) => {
    assert.strictEqual(err.code, 'untrusted-dir');
    assert.ok(err.message.includes(`run \`claude\` once in ${dir} and accept`), err.message);
    return true;
  });
});

test('reports an output without a session id', async (t) => {
  const { dir, state } = setup(t, 'unknown-output');
  await assert.rejects(claude.launch(spec(dir)), (err) => {
    assert.strictEqual(err.code, 'claude-unexpected-output');
    assert.match(err.message, /something went wrong/);
    return true;
  });
  assert.deepStrictEqual(fakeSessions(state), []);
});

test('reports a session that never started', async (t) => {
  const { dir, state } = setup(t, 'never-started');
  process.env.RELAYLEAD_CLAUDE_START_MS = '1000';
  await assert.rejects(claude.launch(spec(dir)), (err) => {
    assert.strictEqual(err.code, 'not-started');
    assert.match(err.message, /; it was stopped$/);
    return true;
  });
  // No orphan: the session that did not start was stopped.
  const [row] = fakeSessions(state);
  assert.strictEqual(row.state, 'stopped');
  assert.deepStrictEqual(calls(state).at(-1), ['stop', row.id]);
});

test('a session in a state this version does not know is not taken as started', async (t) => {
  const { dir, state } = setup(t, 'unknown-state');
  process.env.RELAYLEAD_CLAUDE_START_MS = '1000';
  await assert.rejects(claude.launch(spec(dir)), { code: 'not-started' });
  assert.strictEqual(fakeSessions(state)[0].state, 'stopped');
});

test('a session that never started and cannot be stopped is reported as an orphan', async (t) => {
  const { dir, state } = setup(t, 'never-started,unstoppable');
  process.env.RELAYLEAD_CLAUDE_START_MS = '1000';
  await assert.rejects(claude.launch(spec(dir)), (err) => {
    const id = fakeSessions(state)[0].id;
    assert.strictEqual(err.code, 'not-started');
    assert.strictEqual(err.orphan, id);
    assert.ok(err.message.endsWith(`could not stop ${id}: run \`claude stop ${id}\``), err.message);
    return true;
  });
});

test('wake resumes under the same id', async (t) => {
  const { dir, state } = setup(t);
  const session = await claude.launch(spec(dir));
  recordSession('demo', session);
  const [{ sleeper }] = fakeSessions(state);
  const woken = await claude.wake(session, 'Go on with the answer: 57');
  assert.strictEqual(woken.shortId, session.shortId);
  assert.strictEqual(woken.state, 'working');
  assert.notStrictEqual(woken.pid, session.pid);
  assert.strictEqual(sleeperEnded(state, sleeper), true);
  const resumes = calls(state).filter((args) => args.includes('--resume'));
  assert.deepStrictEqual(resumes, [['--bg', '--resume', session.sessionId, 'Go on with the answer: 57']]);
  assert.strictEqual(fakeSessions(state).length, 1);
});

test('wake detects a copy and stops it', async (t) => {
  const { dir, state } = setup(t);
  const session = await claude.launch(spec(dir));
  process.env.FAKE_CLAUDE_SCENARIO = 'wake-copy';
  await assert.rejects(claude.wake(session, 'hello'), (err) => {
    assert.strictEqual(err.code, 'wake-copy');
    assert.match(err.message, /; the copy was stopped$/);
    return true;
  });
  const copy = fakeSessions(state).find((row) => row.id !== session.shortId);
  assert.strictEqual(copy.state, 'stopped');
  assert.deepStrictEqual(calls(state).at(-1), ['stop', copy.id]);
});

// The `agents` calls made between the wake's stop and its resume: each is one round of the wait.
function agentsCallsBeforeResume(state) {
  const all = calls(state);
  const resumeAt = all.findIndex((args) => args.includes('--resume'));
  const stopAt = all.slice(0, resumeAt).map((args) => args[0]).lastIndexOf('stop');
  assert.ok(stopAt !== -1 && resumeAt > stopAt, JSON.stringify(all));
  return all.slice(stopAt, resumeAt).filter((args) => args[0] === 'agents').length;
}

test('wake waits for the registry pid of a session claude lists without a process, at most the short bound', async (t) => {
  const { dir, state } = setup(t);
  const session = await claude.launch(spec(dir));
  await claude.stop(session);
  // A stopped row has no pid. The registry pid is waited for: the wake may be run again after one
  // that gave up, while the process lingers. Here it belongs to another live process: it only costs
  // the short bound, not the whole wait.
  process.env.RELAYLEAD_CLAUDE_WAKE_SETTLE_MS = '300';
  const start = Date.now();

  const woken = await claude.wake({ ...session, pid: process.pid }, 'hello');

  assert.strictEqual(woken.shortId, session.shortId);
  // The first round sees no pid listed; the bound has not passed yet, so a later round resumes.
  assert.ok(agentsCallsBeforeResume(state) >= 2, JSON.stringify(calls(state)));
  assert.ok(Date.now() - start < 15000, `woken in ${Date.now() - start} ms`);
});

test('wake detects the other recorded copy output', async (t) => {
  const { dir, state } = setup(t);
  const session = await claude.launch(spec(dir));
  process.env.FAKE_CLAUDE_SCENARIO = 'wake-copy-2';
  await assert.rejects(claude.wake(session, 'hello'), { code: 'wake-copy' });
  const copy = fakeSessions(state).find((row) => row.id !== session.shortId);
  assert.strictEqual(copy.state, 'stopped');
});

test('a wake copy that cannot be stopped is reported as an orphan', async (t) => {
  const { dir, state } = setup(t);
  const session = await claude.launch(spec(dir));
  process.env.FAKE_CLAUDE_SCENARIO = 'wake-copy,unstoppable';
  await assert.rejects(claude.wake(session, 'hello'), (err) => {
    const copy = fakeSessions(state).find((row) => row.id !== session.shortId);
    assert.strictEqual(err.code, 'wake-copy');
    assert.strictEqual(err.orphan, copy.id);
    assert.ok(err.message.endsWith(`could not stop ${copy.id}: run \`claude stop ${copy.id}\``), err.message);
    return true;
  });
});

test('a wake that worked is not undone by a failing agents list', async (t) => {
  const { dir } = setup(t);
  const session = await claude.launch(spec(dir));
  process.env.FAKE_CLAUDE_SCENARIO = 'agents-fail-after-wake';
  const woken = await claude.wake(session, 'hello');
  assert.strictEqual(woken.shortId, session.shortId);
  assert.strictEqual(woken.state, 'working');
});

test(
  'wake gives up when the session process does not end',
  { skip: process.platform === 'win32' && 'POSIX only: on Windows, the wait for the process is bounded' },
  async (t) => {
    const { dir, state } = setup(t);
    const session = await claude.launch(spec(dir));
    process.env.FAKE_CLAUDE_SCENARIO = 'stuck-stop';
    process.env.RELAYLEAD_CLAUDE_WAKE_MS = '500';
    await assert.rejects(claude.wake(session, 'hello'), (err) => {
      assert.strictEqual(err.code, 'wake-timeout');
      return true;
    });
    // Run again, the wake finds the row without a pid: it waits for the registry pid all the same.
    await assert.rejects(claude.wake(session, 'hello'), { code: 'wake-timeout' });
    assert.strictEqual(calls(state).filter((args) => args.includes('--resume')).length, 0);
  },
);

test(
  'wake waits at most the settle bound on Windows',
  { skip: process.platform !== 'win32' && 'Windows only: elsewhere, the wait for the process is not bounded' },
  async (t) => {
    const { dir, state } = setup(t);
    const session = await claude.launch(spec(dir));
    const [{ sleeper }] = fakeSessions(state);
    // The row loses its pid at the stop, but the process keeps running (measured fact 1).
    process.env.FAKE_CLAUDE_SCENARIO = 'stuck-stop';
    process.env.RELAYLEAD_CLAUDE_WAKE_SETTLE_MS = '1000';
    const start = Date.now();
    const stoppedAt = whenRowLosesPid(state, session.shortId);

    const woken = await claude.wake(session, 'hello');

    // The time from the stop (seen by the test no sooner than it happened) to the end of the wake.
    const sinceStop = Date.now() - (await stoppedAt);
    assert.strictEqual(woken.shortId, session.shortId);
    assert.ok(sinceStop >= 1000, `woken ${sinceStop} ms after the stop`);
    assert.ok(agentsCallsBeforeResume(state) >= 2, JSON.stringify(calls(state)));
    assert.strictEqual(sleeperEnded(state, sleeper), false); // resumed on the bound, process alive
    assert.ok(Date.now() - start < 15000, `woken in ${Date.now() - start} ms`);
  },
);

// Resolves with the time at which the fake claude's row of the session is first read without a pid,
// read every 20 ms; with Infinity if it keeps its pid for 20 s.
async function whenRowLosesPid(state, shortId) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const row = fakeSessions(state).find((candidate) => candidate.id === shortId);
    if (row && !row.pid) return Date.now();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return Infinity;
}
