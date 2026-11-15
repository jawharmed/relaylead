const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const claude = require('../adapters/claude');
const { recordSession, isAlive } = require('../core/sessions');
const { missionDir } = require('../core/paths');
const { writeJson } = require('../core/store');
const { tmpDir } = require('../fixtures/helpers');

const FAKE = path.join(__dirname, '..', 'fixtures', 'claude', 'fake-claude.js');
const PROFILE = { name: 'developer', model: 'sonnet', effort: 'low', tools: ['Read', 'Edit'], instructions: 'Be brief.' };
const ENV_KEYS = [
  'RELAYLEAD_HOME', 'RELAYLEAD_CLAUDE', 'RELAYLEAD_CLAUDE_START_MS', 'RELAYLEAD_CLAUDE_WAKE_MS',
  'RELAYLEAD_CLAUDE_COMMAND_MS', 'RELAYLEAD_CLAUDE_LAUNCH_MS',
  'FAKE_CLAUDE_STATE', 'FAKE_CLAUDE_SCENARIO',
];

// Fresh home, project folder and fake claude state. After the test, every process the fake
// started is killed (a stopped row no longer shows its pid) and the environment is put back.
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
    for (const pid of fakePids(state)) {
      if (isAlive(pid)) process.kill(pid);
    }
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

function fakePids(state) {
  try {
    return fs.readFileSync(path.join(state, 'pids.log'), 'utf8').trim().split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
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

test('list keeps the mission sessions; stop and attach use the short id', async (t) => {
  const { dir, state } = setup(t);
  const mine = await claude.launch(spec(dir));
  // Launched but not in the registry: not one of the mission's sessions.
  await claude.launch(spec(dir, { name: 'demo/developer/2' }));
  recordSession('demo', mine);

  assert.deepStrictEqual((await claude.list('demo')).map((s) => [s.shortId, s.state]), [[mine.shortId, 'working']]);
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
  const woken = await claude.wake(session, 'Go on with the answer: 57');
  assert.strictEqual(woken.shortId, session.shortId);
  assert.strictEqual(woken.state, 'working');
  assert.notStrictEqual(woken.pid, session.pid);
  assert.strictEqual(isAlive(session.pid), false);
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
    return true;
  });
  const copy = fakeSessions(state).find((row) => row.id !== session.shortId);
  assert.strictEqual(copy.state, 'stopped');
  assert.deepStrictEqual(calls(state).at(-1), ['stop', copy.id]);
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

test('wake gives up when the session process does not end', async (t) => {
  const { dir, state } = setup(t);
  const session = await claude.launch(spec(dir));
  process.env.FAKE_CLAUDE_SCENARIO = 'stuck-stop';
  process.env.RELAYLEAD_CLAUDE_WAKE_MS = '500';
  await assert.rejects(claude.wake(session, 'hello'), (err) => {
    assert.strictEqual(err.code, 'wake-timeout');
    return true;
  });
  assert.strictEqual(calls(state).filter((args) => args.includes('--resume')).length, 0);
});
