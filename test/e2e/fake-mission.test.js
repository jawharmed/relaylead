// A whole mission through the real CLI, with the fake agent, on a copy of fixtures/toy-repo.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { listSessions } = require('../../core/sessions');
const { readJson } = require('../../core/store');
const { missionDir } = require('../../core/paths');
const fake = require('../../adapters/fake');
const { tmpDir, waitFor, sessionEnded, userEnv } = require('../../fixtures/helpers');
const { git, gitRepo } = require('../../fixtures/git');
const { missionReport } = require('../../fixtures/missions');

const BIN = path.join(__dirname, '..', '..', 'bin', 'relaylead.js');
const TOY_REPO = path.join(__dirname, '..', '..', 'fixtures', 'toy-repo');
// Windows runners are slow: a whole mission may take a while there.
const MISSION_MS = 60 * 1000;

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

// Every file under `folder` ({relative path with / separators: text}), leaving out `skip` folders.
function readFiles(folder, skip = []) {
  const files = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      const name = path.relative(folder, file).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (!skip.includes(name)) walk(file);
      } else {
        files[name] = fs.readFileSync(file, 'utf8');
      }
    }
  };
  walk(folder);
  return files;
}

// Everything the user sees in their checkout.
function checkoutState(dir) {
  return {
    branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),
    head: git(dir, 'rev-parse', 'HEAD'),
    status: git(dir, 'status', '--porcelain', '--untracked-files=all'),
    files: readFiles(dir, ['.git', '.relaylead']),
  };
}

// The folders of `git worktree list`, spelled like fs.realpathSync.native spells them.
function worktrees(dir) {
  return git(dir, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => fs.realpathSync.native(line.slice('worktree '.length)));
}

// Launches a mission named `name` (the folder's name when null) in `dir` with the fake agent, answers
// the question of task b if it comes, and waits for the mission to be done. Its sessions are stopped
// after the test. Returns the mission name and a report() for failure messages.
async function runMission(t, dir, name) {
  let mission = null;
  t.after(async () => {
    if (mission) for (const session of listSessions(mission)) await fake.stop(session);
  });
  // The last poll's exit code and stderr go into a timeout report: a failing command shows there.
  let lastPoll = null;
  const poll = async (args) => {
    const result = await relaylead(args, dir);
    lastPoll = { args, code: result.code, err: result.err };
    return result;
  };
  const report = () => `--- last poll\n${JSON.stringify(lastPoll)}\n` + missionReport(mission);

  const nameArgs = name ? ['--name', name] : [];
  const launched = await relaylead(['launch', '--agent', 'fake', ...nameArgs, '--request', 'Do the tasks'], dir);
  assert.strictEqual(launched.code, 0, launched.err);
  mission = launched.out.trim();

  await waitFor(
    async () => {
      const [question] = JSON.parse((await poll(['question', 'list', mission])).out || '[]');
      if (question) {
        assert.strictEqual(question.text, 'Should greet speak English only, or English and French?');
        const answered = await relaylead(['answer', mission, question.id, '1'], dir);
        assert.strictEqual(answered.code, 0, answered.err);
      }
      return (await poll(['state', 'get', '--mission', mission])).out.trim() === 'done';
    },
    MISSION_MS,
    'the mission to be done',
    report,
  );
  return { mission, report };
}

test('fake mission delivers two tasks with one answered question', { timeout: 3 * MISSION_MS }, async (t) => {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  const dir = gitRepo(readFiles(TOY_REPO));
  const before = checkoutState(dir);
  const { mission, report } = await runMission(t, dir, null);

  // The fake lead offers "yes" and "no" whatever the ask text says (a real lead offers the
  // choices of the text): option 1 is "yes".
  const questions = JSON.parse((await relaylead(['question', 'list', mission, '--all'], dir)).out);
  assert.strictEqual(questions.length, 1, report());
  const [settled] = questions;
  assert.deepStrictEqual([settled.state, settled.answer.choice], ['answered', 'yes']);

  // Both task branches are merged into the integration branch, and the source says done there.
  const integration = 'relaylead/integration';
  const merges = git(dir, 'log', '--merges', '--format=%s', integration);
  for (const id of ['a', 'b']) {
    assert.match(merges, new RegExp(`Merge branch 'relaylead/${mission}/${id}'`), report());
    assert.strictEqual(git(dir, 'show', `${integration}:${id}.txt`), `fake work on ${id}`);
    assert.match(git(dir, 'show', `${integration}:tasks/${id}.md`), /^state: done\r?$/m);
  }

  // The fake lead logs each command it runs, when it starts and when it ends: a command that never
  // ends shows in a timeout report.
  const lead = listSessions(mission).find((session) => session.role === 'lead');
  const leadLog = fs.readFileSync(path.join(missionDir(mission), `fake-lead-${lead.shortId}.log`), 'utf8');
  assert.match(leadLog, /start relaylead task deliver a\n.*end relaylead task deliver a\n/, leadLog);

  // No process of the mission is left: the lead and both crew members have ended, then the helper
  // that stops the lead after `state set done`.
  const sessions = listSessions(mission);
  assert.strictEqual(sessions.length, 3, report());
  await waitFor(() => sessions.every(sessionEnded), 15000, 'every session to end', report);
  // `state set done` writes the state first, then starts the helper and records its pid: the
  // mission may be done before reaper.json exists. The helper writes reaper-ended.json, with its
  // pid, as it exits.
  const reaperFile = path.join(missionDir(mission), 'reaper.json');
  await waitFor(() => fs.existsSync(reaperFile), 15000, 'reaper.json', report);
  const reaper = readJson(reaperFile);
  const endedFile = path.join(missionDir(mission), 'reaper-ended.json');
  await waitFor(() => readJson(endedFile, {}).pid === reaper.pid, 15000, 'the helper to end', report);

  // Only the user's checkout and the integration worktree are left.
  const integrationDir = path.join(dir, '.relaylead', 'worktrees', '_integration');
  assert.deepStrictEqual(worktrees(dir).sort(), [dir, integrationDir].sort());

  assert.deepStrictEqual(checkoutState(dir), before);
  assert.strictEqual(before.branch, 'main');
  assert.strictEqual(before.status, '');
});

test('a second mission runs in the same folder after remove', { timeout: 3 * MISSION_MS }, async (t) => {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  const dir = gitRepo(readFiles(TOY_REPO));
  const { mission } = await runMission(t, dir, null);
  // A new task, committed on the user's branch once the first mission is over.
  fs.writeFileSync(path.join(dir, 'tasks', 'c.md'), '---\ntitle: Third task\n---\n\nWrite c.\n');
  git(dir, 'add', 'tasks/c.md');
  git(dir, 'commit', '-q', '-m', 'task c');
  // `state set done` writes done first, then stops the sessions: remove waits for that end.
  // It waits for the crew processes to end and removes their worktrees: slow on a loaded Windows
  // runner. On a timeout, the state and the journal say where it stopped.
  const stateFile = path.join(missionDir(mission), 'state.json');
  const journalFile = path.join(missionDir(mission), 'journal.log');
  const explain = () =>
    JSON.stringify(readJson(stateFile)) + '\n' + (fs.existsSync(journalFile) ? fs.readFileSync(journalFile, 'utf8') : '(no journal)');
  await waitFor(() => !readJson(stateFile).stopping, MISSION_MS, 'the end of state set done', explain);

  const removed = await relaylead(['remove', mission], dir);
  assert.strictEqual(removed.code, 0, removed.err);

  // The same name again: the folder's.
  const second = await runMission(t, dir, null);
  assert.strictEqual(second.mission, mission);
  assert.strictEqual(git(dir, 'show', 'relaylead/integration:c.txt'), 'fake work on c', second.report());
  const listed = (await relaylead(['list'], dir)).out.trim().split('\n');
  assert.strictEqual(listed.length, 1, listed.join('\n'));
});
