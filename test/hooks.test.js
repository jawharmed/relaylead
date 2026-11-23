// The hooks run as real processes, the way Claude Code runs them: JSON on stdin, decision on stdout.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { writeJson } = require('../core/store');
const { sendMail, readMail } = require('../core/mailbox');
const { readReadings } = require('../core/readings');
const { DEFAULTS } = require('../core/config');
const layout = require('../core/layout');
const { tmpDir } = require('../fixtures/helpers');
const { gitRepo } = require('../fixtures/git');

const PRETOOL = path.join(__dirname, '..', 'core', 'hooks', 'pretool.js');
const PERMISSION = path.join(__dirname, '..', 'core', 'hooks', 'permission.js');

// A fresh RELAYLEAD_HOME whose path contains a space, with mission demo and the given guard.
function missionHome(guard) {
  const home = tmpDir('relaylead home-');
  writeJson(path.join(home, 'missions', 'demo', 'mission.json'), {
    name: 'demo',
    config: { ...structuredClone(DEFAULTS), guard: { ...DEFAULTS.guard, ...guard } },
  });
  return home;
}

function runHook(hook, input, env) {
  const childEnv = { ...process.env, ...env };
  if (!env.RELAYLEAD_MISSION) delete childEnv.RELAYLEAD_MISSION;
  if (!env.RELAYLEAD_ALLOW) delete childEnv.RELAYLEAD_ALLOW;
  const result = spawnSync(process.execPath, [hook], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: childEnv,
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout;
}

function journal(home) {
  const file = path.join(home, 'missions', 'demo', 'journal.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

test('pretool hook prints a deny decision', () => {
  const home = missionHome({ secrets: ['secret.txt'] });
  const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo' };
  const cwd = gitRepo({ 'README.md': 'demo\n' });

  const out = runHook(PRETOOL, { tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd }, env);
  assert.deepStrictEqual(JSON.parse(out), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'Blocked by Relaylead: push to protected branch main. Continue with the rest of the task, one command per call.',
    },
  });
  // The mission guard is used: its own secret list replaces the default one.
  const secret = runHook(PRETOOL, { tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'secret.txt') }, cwd }, env);
  assert.strictEqual(JSON.parse(secret).hookSpecificOutput.permissionDecision, 'deny');

  const lines = journal(home).trim().split('\n');
  assert.strictEqual(lines.length, 2);
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT\S+Z Bash push to protected branch main$/);
  assert.match(lines[1], /^\S+ Read access to secret file secret\.txt$/);
});

test('pretool hook prints nothing for an allowed action', () => {
  const home = missionHome({});
  const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo' };
  const out = runHook(PRETOOL, { tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: tmpDir() }, env);
  assert.strictEqual(out, '');
  assert.strictEqual(journal(home), '');
});

test('pretool hook uses the default guard without a mission', () => {
  const home = tmpDir('relaylead home-');
  const input = { tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd: tmpDir() };
  for (const env of [{ RELAYLEAD_HOME: home }, { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'unknown' }]) {
    assert.strictEqual(JSON.parse(runHook(PRETOOL, input, env)).hookSpecificOutput.permissionDecision, 'deny');
  }
  assert.strictEqual(fs.existsSync(path.join(home, 'missions')), false);
});

test('pretool hook ignores unreadable input and notes it in the journal', () => {
  const home = missionHome({});
  const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo' };
  assert.strictEqual(runHook(PRETOOL, 'not json', env), '');
  assert.strictEqual(runHook(PRETOOL, '[1]', env), '');
  assert.match(journal(home), /^\S+ unknown unreadable hook input\n\S+ unknown unreadable hook input\n$/);
});

test('pretool hook refuses when the guard fails', () => {
  // Wrong shapes fall back to the defaults: protected pushes and secrets are still refused.
  const home = missionHome({ protectedBranches: 'main', secrets: [1], allow: null });
  const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo' };
  const decide = (input) => JSON.parse(runHook(PRETOOL, input, env)).hookSpecificOutput.permissionDecisionReason;
  const cwd = tmpDir();
  assert.match(decide({ tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd }), /push to protected branch main/);
  assert.match(decide({ tool_name: 'Bash', tool_input: { command: 'cat .env' }, cwd }), /access to secret file \.env/);
  // An input the guard cannot judge is refused, not let through.
  assert.match(decide({ tool_name: 'Bash', tool_input: { command: 'cat a.txt' }, cwd: 42 }), /^Blocked by Relaylead: guard error\./);
  assert.match(journal(home), /\S+ Bash guard error\n$/);
});

test('pretool hook refuses the mission state folder', () => {
  const home = missionHome({});
  const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo' };
  const file = path.join(home, 'missions', 'demo', 'mission.json');
  const out = runHook(PRETOOL, { tool_name: 'Write', tool_input: { file_path: file, content: '{}' }, cwd: tmpDir() }, env);
  assert.match(JSON.parse(out).hookSpecificOutput.permissionDecisionReason, /access to the mission state folder/);
});

// A crew member's session of mission demo, whose project is `project` and delivery `delivery`.
function crewHome(project, delivery) {
  const home = tmpDir('relaylead home-');
  writeJson(path.join(home, 'missions', 'demo', 'mission.json'), {
    name: 'demo',
    format: layout.FORMAT,
    dir: project,
    config: { ...structuredClone(DEFAULTS), delivery: { type: delivery } },
  });
  return home;
}

test('pretool hook keeps the writes of a crew member in its working folder', () => {
  const project = tmpDir('relaylead-project-');
  const outside = path.join(tmpDir('relaylead-outside-'), 'proof.txt');
  const mission = { name: 'demo', format: layout.FORMAT, dir: project };
  for (const [delivery, workDir] of [
    ['local-merge', layout.taskDir(mission, 'note')],
    ['files', layout.outDir(mission, 'note')],
  ]) {
    const home = crewHome(project, delivery);
    const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo', RELAYLEAD_TASK: 'note' };
    const write = (file_path) => runHook(PRETOOL, { tool_name: 'Write', tool_input: { file_path, content: 'x' }, cwd: workDir }, env);
    assert.strictEqual(write(path.join(workDir, 'note.md')), '');
    const reason = JSON.parse(write(outside)).hookSpecificOutput.permissionDecisionReason;
    assert.strictEqual(
      reason,
      `Blocked by Relaylead: write outside the working folder ${workDir}. Continue with the rest of the task, one command per call. ` +
        'Do not look for a way around it: finish what you can in your folder and say in your summary what you could not write.',
    );
    assert.match(journal(home), new RegExp(`Write write outside the working folder`));
  }
});

test('pretool hook lets a lead write nowhere and read no key', () => {
  const project = tmpDir('relaylead-project-');
  const home = crewHome(project, 'local-merge');
  const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo' };
  const decide = (tool_name, tool_input) => JSON.parse(runHook(PRETOOL, { tool_name, tool_input, cwd: project }, env)).hookSpecificOutput;
  assert.match(decide('Write', { file_path: path.join(project, 'a.txt') }).permissionDecisionReason, /write by a session that has no working folder/);
  assert.match(decide('Read', { file_path: path.join(home, 'config.json') }).permissionDecisionReason, /read of sensitive location .*config\.json\. .*say in your summary what you could not read\.$/);
});

function questionFiles(home) {
  const dir = path.join(home, 'missions', 'demo', 'questions');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

function readQuestion(home, file) {
  return JSON.parse(fs.readFileSync(path.join(home, 'missions', 'demo', 'questions', file), 'utf8'));
}

function answer(home, id, choice) {
  writeJson(path.join(home, 'missions', 'demo', 'questions', `${id}.answer.json`), { choice, answeredAt: new Date().toISOString() });
}

test('pretool hook asks the user before an irreversible action, and lets it through once', () => {
  const home = missionHome({});
  const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo' };
  const cwd = tmpDir();
  const reason = (command) => {
    const out = runHook(PRETOOL, { session_id: 'fake-session', tool_name: 'Bash', tool_input: { command }, cwd }, env);
    return out ? JSON.parse(out).hookSpecificOutput.permissionDecisionReason : null;
  };

  const first = reason('git reset --hard');
  const [file] = questionFiles(home);
  const id = file.replace(/\.json$/, '');
  assert.match(id, /^q-irr-[0-9a-f]{12}$/);
  assert.strictEqual(first, `Blocked by Relaylead: irreversible: git reset --hard. Asked the user (question ${id}), continue with the rest of the task, one command per call.`);
  const question = readQuestion(home, file);
  assert.deepStrictEqual([question.kind, question.text, question.options, question.recommended], ['irreversible', 'git reset --hard', ['Refuse', 'Allow once'], 1]);
  // The same command again: the same question, never a second one.
  assert.strictEqual(reason('git  reset --hard'), first);
  assert.strictEqual(questionFiles(home).length, 1);

  answer(home, id, 'Allow once');
  // An explicit allow: no permission prompt follows, which would refuse a command out of the allowed
  // tools after its one-time permission is used.
  const allowed = runHook(PRETOOL, { tool_name: 'Bash', tool_input: { command: 'git reset --hard' }, cwd }, env);
  assert.deepStrictEqual(JSON.parse(allowed).hookSpecificOutput, {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    permissionDecisionReason: `allowed once by the user (question ${id})`,
  });
  assert.strictEqual(
    reason('git reset --hard'),
    `Blocked by Relaylead: irreversible: git reset --hard. The user refused it or its one-time permission is already used (question ${id}): do not retry this command, continue with the rest of the task, one command per call.`,
  );
  assert.deepStrictEqual(questionFiles(home), [`${id}.answer.json`, `${id}.json`, `${id}.used.json`]);
  assert.match(journal(home), new RegExp(`Bash allowed once by the user \\(question ${id}\\)`));
});

test('pretool hook keeps refusing an irreversible action the user refused, and asks nothing for an absolute refusal', () => {
  const home = missionHome({});
  const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo' };
  const cwd = gitRepo({ 'README.md': 'demo\n' });
  const decide = (command) => JSON.parse(runHook(PRETOOL, { tool_name: 'Bash', tool_input: { command }, cwd }, env)).hookSpecificOutput;

  decide('git clean -fd');
  const id = questionFiles(home)[0].replace(/\.json$/, '');
  answer(home, id, 'Refuse');
  assert.match(decide('git clean -fd').permissionDecisionReason, /The user refused it .*do not retry this command/);
  assert.strictEqual(decide('git clean -fd').permissionDecision, 'deny');
  assert.strictEqual(questionFiles(home).length, 2);

  const forced = decide('git push --force origin relaylead/x');
  assert.match(forced.permissionDecisionReason, /^Blocked by Relaylead: force push\. Continue/);
  assert.strictEqual(questionFiles(home).length, 2);
});

test('permission hook allows a listed command and denies the rest', () => {
  const home = missionHome({ allow: ['Bash(git status*)'] });
  const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo', RELAYLEAD_ALLOW: JSON.stringify(['Read', 'Bash(npm test*)']) };
  const cwd = tmpDir();
  const decide = (tool_name, tool_input) =>
    JSON.parse(runHook(PERMISSION, { hook_event_name: 'PermissionRequest', tool_name, tool_input, cwd }, env));
  const allow = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };

  assert.deepStrictEqual(decide('Bash', { command: 'git status --short' }), allow);
  assert.deepStrictEqual(decide('Bash', { command: 'npm test' }), allow);
  assert.deepStrictEqual(decide('Read', { file_path: path.join(cwd, 'a.js') }), allow);
  const denied = decide('Bash', { command: 'git status && rm -r src' });
  const id = questionFiles(home)[0].replace(/\.json$/, '');
  assert.match(id, /^q-perm-[0-9a-f]{12}$/);
  assert.deepStrictEqual(denied, {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'deny',
        message: `Blocked by Relaylead: Bash command not in the allowed tools. Asked the user (question ${id}), continue with the rest of the task, one command per call.`,
      },
    },
  });
  assert.strictEqual(decide('Write', { file_path: path.join(cwd, 'a.js') }).hookSpecificOutput.decision.behavior, 'deny');

  const lines = journal(home).trim().split('\n');
  assert.deepStrictEqual(
    lines.map((line) => line.split(' ').slice(1).join(' ')),
    ['Bash Bash command not in the allowed tools', 'Write Write not in the allowed tools'],
  );
  // One question per request out of the lists, about the whole command.
  const questions = questionFiles(home).map((file) => readQuestion(home, file));
  const options = ['Refuse', 'Allow once', 'Always allow in this mission'];
  assert.deepStrictEqual(
    questions.map((question) => [question.kind, question.text, question.options]).sort(),
    [
      ['permission', 'git status && rm -r src', options],
      ['permission', path.join(cwd, 'a.js'), options],
    ].sort(),
  );
});

test('the questions of the hooks are in French when the mission is, and a French answer is honoured', () => {
  const home = missionHome({});
  const file = path.join(home, 'missions', 'demo', 'mission.json');
  writeJson(file, { ...JSON.parse(fs.readFileSync(file, 'utf8')), config: { ...structuredClone(DEFAULTS), language: 'fr' } });
  const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo' };
  const cwd = tmpDir();
  const decide = () => JSON.parse(runHook(PERMISSION, { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'make lint' }, cwd }, env)).hookSpecificOutput.decision.behavior;
  assert.strictEqual(decide(), 'deny');
  const [name] = questionFiles(home);
  const question = readQuestion(home, name);
  assert.deepStrictEqual([...question.options].sort(), ['Autoriser une fois', 'Refuser', 'Toujours autoriser dans cette mission']);
  assert.match(question.context, /^Outil Bash, session s1, dans /);
  answer(home, name.replace(/\.json$/, ''), 'Autoriser une fois');
  assert.deepStrictEqual([decide(), decide()], ['allow', 'deny']);
});

test('permission hook follows the user\'s answer to its question', () => {
  const home = missionHome({});
  const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo' };
  const cwd = tmpDir();
  const decide = (command) =>
    JSON.parse(runHook(PERMISSION, { tool_name: 'Bash', tool_input: { command }, cwd }, env)).hookSpecificOutput.decision.behavior;
  const idOf = (command) => {
    decide(command);
    const file = questionFiles(home).find((name) => /^q-perm-[0-9a-f]{12}\.json$/.test(name) && readQuestion(home, name).text === command);
    return file.replace(/\.json$/, '');
  };

  const always = idOf('make build');
  answer(home, always, 'Always allow in this mission');
  assert.deepStrictEqual([decide('make build'), decide('make build')], ['allow', 'allow']);

  const once = idOf('make lint');
  answer(home, once, 'Allow once');
  assert.deepStrictEqual([decide('make lint'), decide('make lint')], ['allow', 'deny']);

  const refused = idOf('make clean');
  answer(home, refused, 'Refuse');
  assert.strictEqual(decide('make clean'), 'deny');
  // A question with the same id but not asked by the hook (no kind) allows nothing.
  const forged = 'q-perm-' + require('../core/guard').actionHash('Bash', 'make forged');
  writeJson(path.join(home, 'missions', 'demo', 'questions', `${forged}.json`), { id: forged, kind: null, options: ['Always allow in this mission', 'Refuse'] });
  answer(home, forged, 'Always allow in this mission');
  assert.strictEqual(decide('make forged'), 'deny');
  // No new question for an answered one.
  const asked = questionFiles(home).filter((name) => /^q-perm-[0-9a-f]+\.json$/.test(name));
  assert.strictEqual(asked.length, 4);
});

test('permission hook asks at most 10 open permission questions', () => {
  const home = missionHome({});
  const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo' };
  const cwd = tmpDir();
  for (let i = 1; i <= 11; i++) {
    const out = JSON.parse(runHook(PERMISSION, { tool_name: 'Bash', tool_input: { command: `make step${i}` }, cwd }, env));
    assert.strictEqual(out.hookSpecificOutput.decision.behavior, 'deny');
  }
  assert.strictEqual(questionFiles(home).length, 10);
  assert.match(journal(home), /no question asked: 10 permission questions already open\n$/);
});

test('permission hook answers even with a wrong-shaped guard', () => {
  const home = missionHome({ allow: [null] });
  const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo', RELAYLEAD_ALLOW: '[1]' };
  const decide = (input) => JSON.parse(runHook(PERMISSION, input, env)).hookSpecificOutput.decision.behavior;
  assert.strictEqual(decide({ tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: tmpDir() }), 'deny');
  assert.strictEqual(decide({ tool_input: {} }), 'deny');
  assert.strictEqual(decide([1]), 'deny');
  const tools = journal(home).trim().split('\n').map((line) => line.split(' ')[1]);
  assert.deepStrictEqual(tools, ['Bash', 'unknown', 'unknown']);
});

const POSTTOOL = path.join(__dirname, '..', 'core', 'hooks', 'posttool.js');
const STATUSLINE = path.join(__dirname, '..', 'core', 'hooks', 'statusline.js');
const TRANSCRIPT = path.join(__dirname, '..', 'fixtures', 'claude', 'transcript.jsonl');
const SESSION_ID = '0123abcd-4567-89ef-0123-456789abcdef';

function reading(home, folder) {
  return JSON.parse(fs.readFileSync(path.join(home, 'missions', 'demo', folder, '0123abcd.json'), 'utf8'));
}

test('the posttool hook records a heartbeat and keeps the first reading as base', () => {
  const home = missionHome({});
  const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo' };
  const later = path.join(tmpDir(), 'later.jsonl');
  fs.writeFileSync(later, JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 60000 } } }) + '\n');

  const call = (transcript) => runHook(POSTTOOL, { session_id: SESSION_ID, tool_name: 'Bash', transcript_path: transcript }, env);
  assert.strictEqual(call(TRANSCRIPT), '');
  assert.deepStrictEqual([reading(home, 'heartbeats').contextTokens, reading(home, 'heartbeats').baseTokens], [42366, 42366]);
  assert.strictEqual(call(later), '');
  const { at, ...heartbeat } = reading(home, 'heartbeats');
  assert.deepStrictEqual(heartbeat, { tool: 'Bash', contextTokens: 60000, baseTokens: 42366 });
  assert.match(at, /^\d{4}-\d\d-\d\dT\S+Z$/);
  // A transcript not readable yet keeps the last context.
  call(path.join(tmpDir(), 'missing.jsonl'));
  assert.strictEqual(reading(home, 'heartbeats').contextTokens, 60000);
});

test('the posttool hook writes nothing without a mission or a session id', () => {
  const home = missionHome({});
  const input = { session_id: SESSION_ID, tool_name: 'Bash', transcript_path: TRANSCRIPT };
  assert.strictEqual(runHook(POSTTOOL, input, { RELAYLEAD_HOME: home }), '');
  assert.strictEqual(runHook(POSTTOOL, input, { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: '../demo' }), '');
  const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo' };
  assert.strictEqual(runHook(POSTTOOL, { ...input, session_id: undefined }, env), '');
  assert.strictEqual(runHook(POSTTOOL, { ...input, session_id: 'fake-0123abcd' }, env), '');
  assert.strictEqual(runHook(POSTTOOL, 'not json', env), '');
  assert.strictEqual(fs.existsSync(path.join(home, 'missions', 'demo', 'heartbeats')), false);
  // A mission whose folder is gone is not made again.
  assert.strictEqual(runHook(POSTTOOL, input, { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'gone' }), '');
  assert.strictEqual(fs.existsSync(path.join(home, 'missions', 'gone')), false);
});

test('the statusline records the window from the first call, then the context', () => {
  const home = missionHome({});
  const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo' };
  const first = { session_id: SESSION_ID, context_window: { context_window_size: 1000000, current_usage: null } };
  // A blank line: the session is never shown, its status line only measures.
  assert.strictEqual(runHook(STATUSLINE, first, env), '\n');
  const { at, ...before } = reading(home, 'context');
  assert.deepStrictEqual(before, { contextTokens: null, windowTokens: 1000000, baseTokens: null });
  assert.match(at, /^\d{4}-\d\d-\d\dT\S+Z$/);

  const usage = { input_tokens: 2, cache_creation_input_tokens: 9505, cache_read_input_tokens: 33240, output_tokens: 153 };
  runHook(STATUSLINE, { session_id: SESSION_ID, context_window: { context_window_size: 1000000, current_usage: usage } }, env);
  const { at: _at, ...after } = reading(home, 'context');
  assert.deepStrictEqual(after, { contextTokens: 42747, windowTokens: 1000000, baseTokens: 42747 });

  // A later call without usage keeps the context; one without a session id writes nothing.
  runHook(STATUSLINE, first, env);
  assert.strictEqual(reading(home, 'context').contextTokens, 42747);
  assert.strictEqual(runHook(STATUSLINE, { context_window: first.context_window }, env), '\n');
  assert.strictEqual(runHook(STATUSLINE, 'not json', env), '\n');
  assert.deepStrictEqual(fs.readdirSync(path.join(home, 'missions', 'demo', 'context')), ['0123abcd.json']);
});

test('a status line with an empty usage is no reading, and sets no base', () => {
  const home = missionHome({});
  const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo' };
  const call = (usage) =>
    runHook(STATUSLINE, { session_id: SESSION_ID, context_window: { context_window_size: 1000000, current_usage: usage } }, env);
  call({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 });
  assert.deepStrictEqual([reading(home, 'context').contextTokens, reading(home, 'context').baseTokens], [null, null]);
  call({ input_tokens: 2, cache_creation_input_tokens: 9505, cache_read_input_tokens: 33240 });
  call({});
  assert.deepStrictEqual([reading(home, 'context').contextTokens, reading(home, 'context').baseTokens], [42747, 42747]);
});

const STOP = path.join(__dirname, '..', 'core', 'hooks', 'stop.js');
const STOPFAILURE = path.join(__dirname, '..', 'core', 'hooks', 'stopfailure.js');

function readMailNames(home, ...folder) {
  const dir = path.join(home, 'missions', 'demo', 'mailbox', '0123abcd', ...folder);
  return fs.readdirSync(dir).filter((name) => name.endsWith('.md')).sort();
}

test('the posttool hook passes the mail on as additional context', () => {
  const home = missionHome({});
  const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo' };
  process.env.RELAYLEAD_HOME = home;
  sendMail('demo', '0123abcd', 'first');
  sendMail('demo', '0123abcd', 'second');

  const out = runHook(POSTTOOL, { session_id: SESSION_ID, tool_name: 'Bash', transcript_path: TRANSCRIPT }, env);
  assert.deepStrictEqual(JSON.parse(out), {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: 'Message from Relaylead: first\n\nMessage from Relaylead: second',
    },
  });
  assert.strictEqual(reading(home, 'heartbeats').contextTokens, 42366);
  assert.deepStrictEqual(readMailNames(home), []);
  assert.strictEqual(readMailNames(home, 'read').length, 2);
  // The mail is passed on once: the next action has none.
  assert.strictEqual(runHook(POSTTOOL, { session_id: SESSION_ID, tool_name: 'Bash' }, env), '');
});

test('a mail read but not marked is passed on again', () => {
  const home = missionHome({});
  const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo' };
  process.env.RELAYLEAD_HOME = home;
  sendMail('demo', '0123abcd', 'do it again');
  // As by a hook killed after it printed the mail, before it filed it as read.
  assert.strictEqual(readMail('demo', '0123abcd').length, 1);

  const out = runHook(POSTTOOL, { session_id: SESSION_ID, tool_name: 'Bash' }, env);
  assert.strictEqual(JSON.parse(out).hookSpecificOutput.additionalContext, 'Message from Relaylead: do it again');
  assert.deepStrictEqual(readMailNames(home), []);
});

test('a hook whose output is closed before it is read exits 0 and leaves the mail unread', async () => {
  const home = missionHome({});
  process.env.RELAYLEAD_HOME = home;
  sendMail('demo', '0123abcd', 'not read yet');
  const env = { ...process.env, RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo' };
  const child = spawn(process.execPath, [POSTTOOL], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  // Closed before the hook writes, as when Claude Code gives the hook up.
  child.stdout.destroy();
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.stdin.end(JSON.stringify({ session_id: SESSION_ID, tool_name: 'Bash' }));
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.deepStrictEqual([code, stderr], [0, '']);
  assert.strictEqual(readMailNames(home).length, 1);
});

test('the stop hook keeps the turn going while mail waits', () => {
  const home = missionHome({});
  const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo' };
  process.env.RELAYLEAD_HOME = home;
  sendMail('demo', '0123abcd', 'task a is done');
  const input = { session_id: SESSION_ID, hook_event_name: 'Stop', transcript_path: TRANSCRIPT, stop_hook_active: false };

  assert.deepStrictEqual(JSON.parse(runHook(STOP, input, env)), {
    decision: 'block',
    reason: 'Message from Relaylead: task a is done',
  });
  const { at, ...heartbeat } = reading(home, 'heartbeats');
  assert.deepStrictEqual(heartbeat, { tool: '(stop)', contextTokens: 42366, baseTokens: 42366 });
  assert.deepStrictEqual(readMailNames(home), []);

  // The mail is taken: the turn may end this time.
  fs.rmSync(path.join(home, 'missions', 'demo', 'heartbeats'), { recursive: true });
  assert.strictEqual(runHook(STOP, { ...input, stop_hook_active: true }, env), '');
  assert.strictEqual(reading(home, 'heartbeats').tool, '(stop)');
  // Without a mission folder, nothing is written and the turn ends.
  assert.strictEqual(runHook(STOP, input, { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'gone' }), '');
  assert.strictEqual(fs.existsSync(path.join(home, 'missions', 'gone')), false);
});

test('the stopfailure hook records the error and its message', () => {
  const home = missionHome({});
  const env = { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'demo' };
  const message = "You've hit your 5-hour limit · resets 2:54am (Europe/Paris)";
  const input = { session_id: SESSION_ID, hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: message };

  assert.strictEqual(runHook(STOPFAILURE, input, env), '');
  const { at, ...failure } = reading(home, 'failures');
  assert.deepStrictEqual(failure, { error: 'rate_limit', message });
  assert.match(at, /^\d{4}-\d\d-\d\dT\S+Z$/);
  process.env.RELAYLEAD_HOME = home;
  assert.strictEqual(readReadings('demo', '0123abcd').failure.error, 'rate_limit');

  // A failure without its fields is still recorded; without a session id or a mission, nothing.
  runHook(STOPFAILURE, { session_id: SESSION_ID }, env);
  assert.deepStrictEqual([reading(home, 'failures').error, reading(home, 'failures').message], [null, null]);
  assert.strictEqual(runHook(STOPFAILURE, { error: 'rate_limit' }, env), '');
  assert.strictEqual(runHook(STOPFAILURE, input, { RELAYLEAD_HOME: home, RELAYLEAD_MISSION: 'gone' }), '');
  assert.strictEqual(runHook(STOPFAILURE, 'not json', env), '');
  assert.deepStrictEqual(fs.readdirSync(path.join(home, 'missions', 'demo', 'failures')), ['0123abcd.json']);
  assert.strictEqual(fs.existsSync(path.join(home, 'missions', 'gone')), false);
});

test('the fake 429 server answers a rate limit with its reset headers', async (t) => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'fixtures', 'fake-429.js')], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => server.kill());
  const port = await new Promise((resolve, reject) => {
    let out = '';
    server.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('\n')) resolve(Number(out.trim()));
    });
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error(`fake-429 exited with ${code}`)));
  });
  assert.ok(port > 0);

  const response = await new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages' }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    request.once('error', reject);
    request.end('{}');
  });
  assert.strictEqual(response.status, 429);
  assert.strictEqual(response.headers['retry-after'], '3600');
  assert.strictEqual(response.headers['anthropic-ratelimit-unified-status'], 'rejected');
  const reset = Number(response.headers['anthropic-ratelimit-unified-reset']);
  assert.ok(Math.abs(reset - (Math.floor(Date.now() / 1000) + 3600)) <= 5, `reset ${reset}`);
  assert.strictEqual(JSON.parse(response.body).error.type, 'rate_limit_error');
});
