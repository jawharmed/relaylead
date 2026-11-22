// The installation, start to end, with the fake launchctl, the fake claude and the fake agent:
// init, install, doctor, a mission in api-key mode finished by hand-run watcher passes (as launchd
// would run them), then uninstall.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { listSessions } = require('../../core/sessions');
const fake = require('../../adapters/fake');
const { waitFor } = require('../../fixtures/helpers');
const { gitRepo } = require('../../fixtures/git');
const { installEnv, runRelaylead, outsideSnapshot } = require('../../fixtures/install-env');

const TOY_REPO = path.join(__dirname, '..', '..', 'fixtures', 'toy-repo');
const SENTINEL = 'sk-test-SENTINEL';
const MISSION_MS = 60 * 1000;

function readFiles(folder) {
  const files = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else files[path.relative(folder, file).split(path.sep).join('/')] = fs.readFileSync(file, 'utf8');
    }
  };
  walk(folder);
  return files;
}

// Every file under `folder` whose text holds the sentinel. A file removed while the walk runs (a lock
// that `state set done` releases, say) holds nothing.
function filesWithSentinel(folder) {
  const found = [];
  const read = (file) => {
    try {
      return fs.readFileSync(file);
    } catch (err) {
      if (err.code === 'ENOENT') return Buffer.alloc(0);
      throw err;
    }
  };
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (read(file).includes(SENTINEL)) found.push(path.relative(folder, file));
    }
  };
  walk(folder);
  return found;
}

test('init, install, doctor, a mission in api-key mode, uninstall', { timeout: 3 * MISSION_MS }, async (t) => {
  const env = installEnv(t, { MY_TEST_KEY: SENTINEL });
  const dir = gitRepo(readFiles(TOY_REPO));
  const run = (...args) => runRelaylead(args, { cwd: dir, env });
  const outputs = [];
  const keep = (result) => {
    outputs.push(result.out, result.err);
    return result;
  };
  const before = outsideSnapshot(env);

  assert.strictEqual(keep(await run('init', '--yes', '--api-key-env', 'MY_TEST_KEY')).code, 0);
  assert.strictEqual(keep(await run('install')).code, 0);
  const doctor = keep(await run('doctor'));
  assert.strictEqual(doctor.code, 0, doctor.out);
  assert.match(doctor.out, /^ok api-key: file found$/m);
  for (const line of doctor.out.trim().split('\n')) assert.match(line, /^ok /, line);

  let mission = null;
  t.after(async () => {
    if (mission) for (const session of listSessions(mission)) await fake.stop(session);
  });
  const launched = keep(await run('launch', '--agent', 'fake', '--request', 'Do the tasks'));
  assert.strictEqual(launched.code, 0, launched.err);
  mission = launched.out.trim();

  // A pass of the watcher, run by hand like launchd runs it, until the mission is done.
  await waitFor(
    async () => {
      const [question] = JSON.parse(keep(await run('question', 'list', mission)).out || '[]');
      if (question) keep(await run('answer', mission, question.id, '1'));
      keep(await run('watcher', 'run'));
      return keep(await run('state', 'get', '--mission', mission)).out.trim() === 'done';
    },
    MISSION_MS,
    'the mission to be done',
  );

  assert.deepStrictEqual(filesWithSentinel(env.RELAYLEAD_HOME), ['api-key']);
  assert.ok(!outputs.join('\n').includes(SENTINEL));

  await waitFor(() => listSessions(mission).every((session) => fs.existsSync(session.endedFile)), 15000, 'every session to end');
  const stateFile = path.join(env.RELAYLEAD_HOME, 'missions', mission, 'state.json');
  await waitFor(() => !JSON.parse(fs.readFileSync(stateFile, 'utf8')).stopping, MISSION_MS, 'the end of state set done');

  assert.strictEqual(keep(await run('uninstall')).code, 0);
  assert.deepStrictEqual(outsideSnapshot(env), before);
});
