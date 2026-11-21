// A whole mission through the real CLI with the fake agent: two GitHub issues become two pull
// requests, merged into the integration branch. GitHub is the fake gh, with a bare repository.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { listSessions } = require('../../core/sessions');
const fake = require('../../adapters/fake');
const { tmpDir, waitFor, userEnv } = require('../../fixtures/helpers');
const { git, gitRepo } = require('../../fixtures/git');
const { missionReport } = require('../../fixtures/missions');
const { fakeGh, issue } = require('../../fixtures/github');

const BIN = path.join(__dirname, '..', '..', 'bin', 'relaylead.js');
const MISSION_MS = 60 * 1000;
const INTEGRATION = 'relaylead/integration';

// Runs `relaylead <args>` in its own process, like a person in a terminal. No shell.
function relaylead(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env: userEnv(), windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('a mission delivers two GitHub issues by two merged pull requests', { timeout: 3 * MISSION_MS }, async (t) => {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  const config = { source: { type: 'github-issues', label: 'relaylead' }, delivery: { type: 'github-pr' } };
  const dir = gitRepo({ 'README.md': 'A test project.\n', '.relaylead.json': JSON.stringify(config) });
  const remote = path.join(tmpDir('relaylead-remote-'), 'repo.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  git(dir, 'remote', 'add', 'origin', `file://${remote}`);
  git(dir, 'push', '-q', 'origin', 'main');
  const github = fakeGh(t, { remote, issues: [issue(1, 'first'), issue(2, 'second'), { ...issue(3, 'not ours'), labels: [] }] });

  let mission = null;
  t.after(async () => {
    if (mission) for (const session of listSessions(mission)) await fake.stop(session);
  });
  const launched = await relaylead(['launch', '--agent', 'fake', '--request', 'Do the issues'], dir);
  assert.strictEqual(launched.code, 0, launched.err);
  mission = launched.out.trim();
  const report = () => `--- gh calls\n${github.calls().map((call) => call.join(' ')).join('\n')}\n` + missionReport(mission);
  await waitFor(
    async () => (await relaylead(['state', 'get', '--mission', mission], dir)).out.trim() === 'done',
    MISSION_MS,
    'the mission to be done',
    report,
  );

  const creates = github.calls().filter((call) => call[0] === 'pr' && call[1] === 'create');
  assert.strictEqual(creates.length, 2, report());
  for (const call of creates) assert.strictEqual(call[call.indexOf('--base') + 1], INTEGRATION);
  const state = github.read();
  assert.deepStrictEqual(state.prs.map((pr) => pr.state), ['MERGED', 'MERGED']);
  assert.deepStrictEqual(state.issues.map((one) => one.state), ['CLOSED', 'CLOSED', 'OPEN']);
  for (const id of ['issue-1', 'issue-2']) {
    assert.strictEqual(git(remote, 'show', `${INTEGRATION}:${id}.txt`), `fake work on ${id}`);
    assert.ok(!fs.existsSync(path.join(dir, '.relaylead', 'worktrees', id)), `the worktree of ${id} should be removed`);
  }
  const listed = await relaylead(['task', 'list', '--mission', mission], dir);
  assert.deepStrictEqual(JSON.parse(listed.out).map((task) => [task.id, task.state]), [
    ['issue-1', 'delivered'],
    ['issue-2', 'delivered'],
  ]);
});
