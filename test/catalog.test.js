const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../core/cli');
const { loadProfile, loadMethod } = require('../core/profiles');
const { readJson } = require('../core/store');
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
  for (const command of ['relaylead task list', 'relaylead task start', 'relaylead wait', 'relaylead task deliver', 'relaylead question ask', 'relaylead state set done']) {
    assert.ok(lead.instructions.includes(command), `lead instructions should mention ${command}`);
  }

  const developer = loadProfile('developer', { dir });
  assert.deepStrictEqual([developer.agent, developer.model, developer.effort], ['claude', 'sonnet', 'medium']);
  assert.deepStrictEqual(developer.tools, [
    'Bash(git *)', 'Bash(npm test*)', 'Bash(npm ci*)', 'Bash(npm install*)', 'Bash(node *)', 'Bash(relaylead task *)',
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
