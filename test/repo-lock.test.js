// The git lock: two missions of one repository change its shared parts one after the other.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { finishTask } = require('../core/tasks');
const { readMission } = require('../core/missions');
const { withRepoLock, repoLockFile } = require('../core/mission-lock');
const { readJson, writeJson } = require('../core/store');
const localMerge = require('../deliveries/local-merge');
const { tmpDir, userEnv } = require('../fixtures/helpers');
const { writeMission } = require('../fixtures/missions');
const { git, gitRepo } = require('../fixtures/git');

const BIN = path.join(__dirname, '..', 'bin', 'relaylead.js');
const TASK_A = '---\ntitle: First task\n---\n\nWrite a.\n';

// Runs bin/relaylead.js in its own process.
function cliProcess(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: userEnv(), windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

// Mission `name` in `dir`, prepared, with task a done: its crew member committed a.txt.
function missionWithTaskDone(name, dir) {
  writeMission(name, dir);
  const mission = readMission(name);
  localMerge.prepareMission(mission);
  const { cwd } = localMerge.prepareTask(mission, { id: 'a' });
  fs.writeFileSync(path.join(cwd, 'a.txt'), `${name}\n`);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', `a of ${name}`);
  finishTask(name, 'a', { state: 'done' });
}

// A pre-merge-commit hook that notes "enter", holds the merge for a moment, then notes "leave".
function slowMergeHook(dir) {
  const log = path.join(tmpDir('relaylead-hook-'), 'merges.log');
  const script = path.join(path.dirname(log), 'hook.js');
  fs.writeFileSync(
    script,
    [
      "const fs = require('node:fs');",
      "fs.appendFileSync(process.argv[2], 'enter\\n');",
      'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);',
      "fs.appendFileSync(process.argv[2], 'leave\\n');",
    ].join('\n'),
  );
  const hook = path.join(dir, '.git', 'hooks', 'pre-merge-commit');
  fs.writeFileSync(hook, `#!/bin/sh\n"${process.execPath}" "${script}" "${log}"\n`);
  fs.chmodSync(hook, 0o755);
  return () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
}

test('the git lock makes the deliveries of two missions merge one after the other', async (t) => {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  const dir = gitRepo({ 'tasks/a.md': TASK_A });
  missionWithTaskDone('one', dir);
  missionWithTaskDone('two', dir);
  const merges = slowMergeHook(dir);

  const results = await Promise.all(['one', 'two'].map((name) => cliProcess(['task', 'deliver', 'a', '--mission', name])));

  assert.deepStrictEqual(results.map((result) => result.code), [0, 0], JSON.stringify(results));
  // Without the lock, both hooks would run at once: enter, enter, leave, leave.
  assert.deepStrictEqual(merges(), ['enter', 'leave', 'enter', 'leave']);
  for (const name of ['one', 'two']) assert.strictEqual(git(dir, 'show', `relaylead/${name}/integration:a.txt`), name);
  assert.strictEqual(fs.existsSync(repoLockFile(dir)), false, 'the lock is released');
});

test('every worktree of a repository shares one git lock, and a folder outside git has none', (t) => {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  const dir = gitRepo({ 'tasks/a.md': TASK_A });
  writeMission('one', dir);
  localMerge.prepareMission(readMission('one'));

  assert.strictEqual(repoLockFile(path.join(dir, '.relaylead', 'worktrees', 'one', '_integration')), repoLockFile(dir));
  assert.strictEqual(repoLockFile(tmpDir('relaylead-project-')), null);
});

test('a git lock left by a process that died is taken over', async (t) => {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  const dir = gitRepo({ 'README.md': 'hello\n' });
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  writeJson(repoLockFile(dir), { pid: deadPid, command: 'task deliver a', since: new Date().toISOString() });
  let held = null;

  const result = await withRepoLock(dir, 'task deliver b', () => {
    held = readJson(repoLockFile(dir));
    return 'merged';
  });

  assert.strictEqual(result, 'merged');
  assert.deepStrictEqual([held.pid, held.command], [process.pid, 'task deliver b']);
  assert.strictEqual(fs.existsSync(repoLockFile(dir)), false);
});

test('a waiter gives up on a git lock held too long, naming its holder', async (t) => {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  process.env.RELAYLEAD_REPO_LOCK_WAIT_MS = '300';
  t.after(() => {
    delete process.env.RELAYLEAD_REPO_LOCK_WAIT_MS;
  });
  const dir = gitRepo({ 'README.md': 'hello\n' });
  writeJson(repoLockFile(dir), { pid: process.pid, command: 'task deliver a', since: new Date().toISOString() });

  await assert.rejects(
    withRepoLock(dir, 'task deliver b', () => assert.fail('the action must not run')),
    (err) => err.code === 'repo-busy' && /relaylead task deliver a/.test(err.message),
  );
});
