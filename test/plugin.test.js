const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { installPlugin, uninstallPlugin, pluginInstalled, PLUGIN_DIR } = require('../core/plugin');
const { tmpDir } = require('../fixtures/helpers');
const pkg = require('../package.json');

const FAKE = path.join(__dirname, '..', 'fixtures', 'claude', 'fake-claude.js');
const COMMANDS = ['launch', 'list', 'show', 'stop', 'answer', 'init', 'doctor'];

test('plugin.json names the plugin and has the version of the package', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.strictEqual(manifest.name, 'relaylead');
  assert.strictEqual(manifest.version, pkg.version);
  const market = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.strictEqual(market.name, 'relaylead-local');
});

test('each command only allows the relaylead command it runs; the plugin has no hook nor agent', () => {
  assert.deepStrictEqual(fs.readdirSync(path.join(PLUGIN_DIR, 'commands')).sort(), COMMANDS.map((name) => `${name}.md`).sort());
  for (const name of COMMANDS) {
    const text = fs.readFileSync(path.join(PLUGIN_DIR, 'commands', `${name}.md`), 'utf8');
    assert.match(text, /^description: .+$/m);
    assert.match(text, new RegExp(`^allowed-tools: Bash\\(relaylead ${name} \\*\\)$`, 'm'));
  }
  assert.deepStrictEqual(fs.readdirSync(PLUGIN_DIR).sort(), ['.claude-plugin', 'commands']);
});

test('installPlugin and uninstallPlugin call claude plugin with the right arguments, in order', (t) => {
  const state = tmpDir('relaylead-fake-claude-');
  const saved = { RELAYLEAD_CLAUDE: process.env.RELAYLEAD_CLAUDE, FAKE_CLAUDE_STATE: process.env.FAKE_CLAUDE_STATE };
  process.env.RELAYLEAD_CLAUDE = FAKE;
  process.env.FAKE_CLAUDE_STATE = state;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  // The `list` calls that check what is there are left out.
  const calls = () =>
    fs.readFileSync(path.join(state, 'calls.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((args) => !args.includes('list'));

  installPlugin(() => {});
  assert.deepStrictEqual(calls(), [
    ['plugin', 'marketplace', 'add', PLUGIN_DIR],
    ['plugin', 'install', 'relaylead@relaylead-local'],
  ]);
  assert.strictEqual(pluginInstalled(), true);

  uninstallPlugin(() => {});
  assert.deepStrictEqual(calls().slice(2), [
    ['plugin', 'uninstall', 'relaylead@relaylead-local'],
    ['plugin', 'marketplace', 'remove', 'relaylead-local'],
  ]);
  assert.strictEqual(pluginInstalled(), false);
});
