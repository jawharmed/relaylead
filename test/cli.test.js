const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { run, commands } = require('../core/cli');
const pkg = require('../package.json');
const { tmpDir } = require('../fixtures/helpers');
const { setupProject, writeMission } = require('../fixtures/missions');
const { withMissionLock } = require('../core/mission-lock');
const { listSessions } = require('../core/sessions');
const { readJson, writeJson } = require('../core/store');
const { missionDir } = require('../core/paths');

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

test('--help after a command prints the help', async () => {
  const io = makeIo();
  assert.strictEqual(await run(['stop', '--help'], io), 0);
  assert.match(io.out.text, /^Usage: relaylead/);
  assert.match(io.out.text, /stop +stop a mission\n/);
});

test('an option value --help is not a request for help', async () => {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  const io = makeIo();
  assert.strictEqual(await run(['state', 'set', 'working', '--note', '--help', '--mission', 'ghost'], io), 1);
  assert.match(io.err.text, /no mission named "ghost"/);
  assert.doesNotMatch(io.out.text, /Usage:/);
});

test('no-mission advises --mission only', async () => {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  const io = makeIo();
  assert.strictEqual(await run(['task', 'list'], io), 1);
  assert.ok(io.err.text.includes('--mission <name>'), io.err.text);
  assert.ok(!io.err.text.includes('RELAYLEAD_MISSION'), io.err.text);

  const project = tmpDir();
  fs.writeFileSync(path.join(project, '.relaylead.json'), JSON.stringify({ language: 'fr' }));
  const fr = { ...makeIo(), cwd: project };
  assert.strictEqual(await run(['task', 'list'], fr), 1);
  assert.ok(fr.err.text.includes('--mission <nom>'), fr.err.text);
  assert.ok(!fr.err.text.includes('RELAYLEAD_MISSION'), fr.err.text);
});

test('an option may be written --name=value', async () => {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  const io = makeIo();
  assert.strictEqual(await run(['task', 'list', '--mission=ghost'], io), 1);
  assert.match(io.err.text, /no mission named "ghost"/);
});

test('remove is refused from inside a session', async () => {
  await assert.rejects(commands.remove(['demo'], makeIo({ RELAYLEAD_MISSION: 'demo' })), { code: 'not-from-a-session' });
});

test('retry is refused to a crew member', async () => {
  const env = { RELAYLEAD_MISSION: 'demo', RELAYLEAD_TASK: 'a' };
  await assert.rejects(commands.task(['retry', 'a'], makeIo(env)), { code: 'not-for-crew' });
});

test('deliver --no-hooks is refused from inside a session', async () => {
  await assert.rejects(commands.task(['deliver', 'a', '--no-hooks'], makeIo({ RELAYLEAD_MISSION: 'demo' })), {
    code: 'not-from-a-session',
    vars: { command: 'task deliver --no-hooks' },
  });
});

// The environment of a lead session: its mission, its role and its name.
function leadEnv(session) {
  return { RELAYLEAD_MISSION: 'demo', RELAYLEAD_ROLE: 'lead', RELAYLEAD_SESSION: session };
}

function missionFile(file) {
  return path.join(missionDir('demo'), file);
}

function nameLead(session) {
  writeJson(missionFile('lead.json'), { sessionId: `fake-${session}`, shortId: 'aaaa1111', sessionName: session, startedAt: new Date().toISOString() });
}

const DRIVING = [
  ['state', 'set', 'working'],
  ['task', 'start', 'a'],
  ['question', 'ask', '--key', 'k', '--text', 'Which one?', '--option', 'x', '--option', 'y'],
  ['wait', '--timeout', '0'],
];

test('a replaced lead can no longer drive the mission', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  nameLead('demo/lead/2');

  for (const args of [...DRIVING, ['task', 'retry', 'a'], ['task', 'deliver', 'a']]) {
    const io = makeIo(leadEnv('demo/lead/1'));
    assert.strictEqual(await run(args, io), 1, args.join(' '));
    assert.match(io.err.text, /this session \(demo\/lead\/1\) is no longer the lead of mission "demo": demo\/lead\/2 took over/);
  }
  for (const file of ['state.json', path.join('tasks', 'a.json'), 'questions', 'wait-snapshot.json']) {
    assert.strictEqual(fs.existsSync(missionFile(file)), false, file);
  }
  assert.deepStrictEqual(listSessions('demo'), []);

  for (const args of DRIVING) {
    const io = makeIo(leadEnv('demo/lead/2'));
    assert.strictEqual(await run(args, io), 0, `${args.join(' ')}: ${io.err.text}`);
  }
  assert.strictEqual(readJson(missionFile('state.json')).state, 'working');
  assert.strictEqual(readJson(missionFile(path.join('tasks', 'a.json'))).state, 'running');
  assert.strictEqual(fs.existsSync(missionFile('wait-snapshot.json')), true);
});

test('the lead of a launch that failed is refused', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  nameLead('demo/lead/1');
  writeJson(missionFile('lead-launch.json'), { n: 2, name: 'demo/lead/2', at: new Date().toISOString(), failed: true });

  const io = makeIo(leadEnv('demo/lead/2'));
  assert.strictEqual(await run(['state', 'set', 'working'], io), 1);
  assert.match(io.err.text, /demo\/lead\/1 took over/);
  assert.strictEqual(fs.existsSync(missionFile('state.json')), false);
});

test('a start queued behind a handover is refused once the lead is replaced', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  nameLead('demo/lead/1');
  let release;
  const holding = withMissionLock('demo', 'hand-over', () => new Promise((resolve) => (release = resolve)));

  // Its first check passes: lead.json still names it. It then waits for the mission lock.
  const io = makeIo(leadEnv('demo/lead/1'));
  const start = run(['task', 'start', 'a'], io);
  nameLead('demo/lead/2');
  release();
  await holding;

  assert.strictEqual(await start, 1);
  assert.match(io.err.text, /demo\/lead\/2 took over/);
  assert.deepStrictEqual(listSessions('demo'), []);
  assert.strictEqual(fs.existsSync(missionFile(path.join('tasks', 'a.json'))), false);
});

test('while a new lead is being launched, the old one can no longer drive the mission', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  writeJson(missionFile('lead.json'), {
    sessionId: 'fake-demo/lead/1',
    shortId: 'aaaa1111',
    sessionName: 'demo/lead/1',
    startedAt: new Date(Date.now() - 60 * 1000).toISOString(),
  });
  const reservation = { n: 2, name: 'demo/lead/2', at: new Date().toISOString() };
  writeJson(missionFile('lead-launch.json'), reservation);

  // Restarted by its agent, the old lead replays its command: refused, the new one has the mission.
  const old = makeIo(leadEnv('demo/lead/1'));
  assert.strictEqual(await run(['state', 'set', 'done'], old), 1);
  assert.match(old.err.text, /this session \(demo\/lead\/1\) is no longer the lead of mission "demo": demo\/lead\/2 took over/);
  assert.strictEqual(fs.existsSync(missionFile('state.json')), false);

  // The launch failed: the old lead has the mission back.
  writeJson(missionFile('lead-launch.json'), { ...reservation, failed: true });
  const back = makeIo(leadEnv('demo/lead/1'));
  assert.strictEqual(await run(['state', 'set', 'working'], back), 0, back.err.text);
});

test('a lead without its session name is told so', async (t) => {
  const dir = setupProject(t, 'demo');
  writeMission('demo', dir);
  nameLead('demo/lead/1');
  const io = makeIo({ RELAYLEAD_MISSION: 'demo', RELAYLEAD_ROLE: 'lead' });
  assert.strictEqual(await run(['state', 'set', 'working'], io), 1);
  assert.match(io.err.text, /this session \(-\) is no longer the lead/);
});
