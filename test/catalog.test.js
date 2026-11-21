const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../core/cli');
const { isAllowed } = require('../core/guard');
const { loadProfile, loadMethod } = require('../core/profiles');
const { readJson } = require('../core/store');
const { t } = require('../core/messages');
const { missionDir } = require('../core/paths');
const fake = require('../adapters/fake');
const { tmpDir, makeIo } = require('../fixtures/helpers');
const { freshHome } = require('../fixtures/missions');

async function cli(args) {
  const io = makeIo();
  const code = await run(args, io);
  return { code, out: io.out.text, err: io.err.text };
}

// Keeps the spec of each launch, without changing what it does.
function spyLaunches(t) {
  const original = fake.launch;
  const specs = [];
  fake.launch = async (spec) => {
    specs.push(spec);
    return original(spec);
  };
  t.after(() => {
    fake.launch = original;
  });
  return specs;
}

test('catalog profiles parse with the expected fields', () => {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  const dir = tmpDir('relaylead-project-');

  const lead = loadProfile('lead', { dir });
  assert.deepStrictEqual([lead.agent, lead.model, lead.effort], ['claude', 'opus', 'medium']);
  for (const command of ['relaylead task list', 'relaylead task start', 'relaylead wait', 'relaylead task deliver', 'relaylead task retry', 'relaylead question ask', 'relaylead state set done']) {
    assert.ok(lead.instructions.includes(command), `lead instructions should mention ${command}`);
  }

  const developer = loadProfile('developer', { dir });
  assert.deepStrictEqual([developer.agent, developer.model, developer.effort], ['claude', 'sonnet', 'medium']);
  assert.deepStrictEqual(developer.tools, [
    'Bash(git *)', 'Bash(npm test*)', 'Bash(npm ci --ignore-scripts)', 'Bash(npm install --ignore-scripts)', 'Bash(node *)', 'Bash(relaylead task *)',
    'Read', 'Write', 'Edit', 'Glob', 'Grep',
  ]);
  for (const command of ['relaylead task done', 'relaylead task fail']) {
    assert.ok(developer.instructions.includes(command), `developer instructions should mention ${command}`);
  }

  const method = loadMethod('code', { dir });
  assert.strictEqual(method.name, 'code');
  for (const command of ['relaylead wait', 'relaylead task deliver', 'relaylead state set done']) {
    assert.ok(method.instructions.includes(command), `the code method should mention ${command}`);
  }
});

// The lead recognises a refusal by a git hook from the first words of the error, in both languages.
test('the lead quotes the first words of the hook-failed error as they are', () => {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  const { instructions } = loadProfile('lead', { dir: tmpDir('relaylead-project-') });
  const quoted = instructions.match(/the error starts with "([^"]+)", or "([^"]+)" in French/);
  assert.ok(quoted, 'the lead instructions should quote the start of the hook-failed error');
  assert.ok(t('hook-failed', {}, 'en').startsWith(quoted[1]), quoted[1]);
  assert.ok(t('hook-failed', {}, 'fr').startsWith(quoted[2]), quoted[2]);
});

// The user runs the command outside the mission folder: the lead quotes it with its --mission.
test('the lead quotes the no-hooks command of the hook-failed error with its --mission', () => {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  const { instructions } = loadProfile('lead', { dir: tmpDir('relaylead-project-') });
  const command = 'relaylead task deliver <id> --no-hooks --mission <mission>';
  for (const lang of ['en', 'fr']) {
    assert.ok(t('hook-failed', { id: '<id>', mission: '<mission>' }, lang).endsWith(command), lang);
  }
  assert.ok(instructions.includes(`\`${command}\``), 'the lead instructions should give the command with --mission');
  assert.ok(instructions.includes('as it is, `--mission` included'), 'the lead should quote the command as it is');
});

test('lead tools only allow its relaylead commands and read-only git', () => {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  const { tools } = loadProfile('lead', { dir: tmpDir('relaylead-project-') });

  const shell = [
    'Bash(relaylead task *)', 'Bash(relaylead wait*)', 'Bash(relaylead question *)', 'Bash(relaylead state *)',
    'Bash(git status)', 'Bash(git log *)',
  ];
  assert.deepStrictEqual(tools, [...shell, 'Read', 'Glob', 'Grep']);
});

test('lead prompt contains the method and the request', async (t) => {
  freshHome(t);
  const dir = tmpDir('relaylead-project-');
  const specs = spyLaunches(t);

  const launched = await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir, '--request', 'Add a dark theme']);
  assert.strictEqual(launched.code, 0, launched.err);

  const [spec] = specs;
  assert.ok(spec.prompt.includes(loadMethod('code', { dir }).instructions), 'the prompt should hold the method');
  assert.ok(spec.prompt.includes('Add a dark theme'), 'the prompt should hold the request');
  assert.ok(spec.prompt.includes('demo'), 'the prompt should name the mission');
  // The lead's own instructions go with the profile (--append-system-prompt), not in the prompt.
  assert.deepStrictEqual(spec.profile, loadProfile('lead', { dir }));
});

test('show attaches to the current lead', async (t) => {
  freshHome(t);
  const dir = tmpDir('relaylead-project-');
  assert.strictEqual((await cli(['launch', '--agent', 'fake', '--name', 'demo', '--dir', dir])).code, 0);
  const lead = readJson(path.join(missionDir('demo'), 'lead.json'));

  const shown = await cli(['show', 'demo']);

  assert.strictEqual(shown.code, 0, shown.err);
  const log = fs.readFileSync(path.join(missionDir('demo'), 'fake-attach.log'), 'utf8');
  assert.match(log, new RegExp(`attach ${lead.shortId}\\n$`));
  const unknown = await cli(['show', 'ghost']);
  assert.strictEqual(unknown.code, 1);
  assert.match(unknown.err, /ghost/);
});

test('the developer may install dependencies only without their scripts', () => {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  const { tools } = loadProfile('developer', { dir: tmpDir('relaylead-project-') });
  const allowed = (command) => isAllowed({ tool_name: 'Bash', tool_input: { command } }, tools);

  for (const command of ['npm ci --ignore-scripts', 'npm install --ignore-scripts']) {
    assert.strictEqual(allowed(command), true, command);
  }
  for (const command of [
    'npm ci', 'npm install', 'npm i left-pad', 'npm install --ignore-scripts left-pad', 'npm ci --ignore-scripts=false',
    'npm ci --ignore-scripts && npm install', 'npm_config_ignore_scripts=false npm ci --ignore-scripts',
  ]) {
    assert.strictEqual(allowed(command), false, command);
  }
});

test('the developer instructions install without scripts', () => {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  const { instructions } = loadProfile('developer', { dir: tmpDir('relaylead-project-') });
  assert.ok(instructions.includes('npm ci --ignore-scripts'));
  assert.ok(!instructions.includes('`npm ci` or `npm install` first'));
});

test('the toy repository pins a dependency without scripts', () => {
  const toy = path.join(__dirname, '..', 'fixtures', 'toy-repo');
  const lock = JSON.parse(fs.readFileSync(path.join(toy, 'package-lock.json'), 'utf8'));
  assert.strictEqual(lock.packages['node_modules/ms'].version, '2.1.3');
  assert.deepStrictEqual(Object.values(lock.packages).filter((entry) => entry.hasInstallScript), []);
  assert.ok(fs.readFileSync(path.join(toy, 'lib', 'duration.js'), 'utf8').includes("require('ms')"));
});

test('the lead method ends the turn only when no task runs', () => {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
  const dir = tmpDir('relaylead-project-');
  const method = loadMethod('code', { dir }).instructions;
  assert.ok(method.includes('relaylead wait --timeout 0'));
  assert.ok(method.includes('end your turn: Relaylead wakes you'));
  assert.ok(method.includes('While a task is running, run `relaylead wait --timeout 540`'));
  const lead = loadProfile('lead', { dir }).instructions;
  assert.ok(lead.includes('## Being woken'));
  assert.ok(lead.includes('not-current-lead'));
  assert.ok(lead.includes('`relaylead wait --timeout 0`'));
});
