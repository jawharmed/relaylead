const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { buildPlist, installScheduler, uninstallScheduler, schedulerStatus, plistPath } = require('../core/scheduler');
const { tmpDir } = require('../fixtures/helpers');

const FAKE = path.join(__dirname, '..', 'fixtures', 'launchctl', 'fake-launchctl.js');
const KEYS = ['RELAYLEAD_HOME', 'RELAYLEAD_LAUNCHD_DIR', 'RELAYLEAD_LAUNCHCTL', 'RELAYLEAD_PLATFORM', 'FAKE_LAUNCHCTL_STATE'];

// Fresh home, LaunchAgents folder and fake launchctl state; the environment is put back afterwards.
function setup(t) {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  const state = tmpDir('relaylead-fake-launchctl-');
  Object.assign(process.env, {
    RELAYLEAD_HOME: tmpDir('relaylead-home-'),
    RELAYLEAD_LAUNCHD_DIR: tmpDir('relaylead-agents-'),
    RELAYLEAD_LAUNCHCTL: FAKE,
    RELAYLEAD_PLATFORM: 'darwin',
    FAKE_LAUNCHCTL_STATE: state,
  });
  t.after(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  return state;
}

const calls = (state) =>
  fs.readFileSync(path.join(state, 'calls.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));

test('buildPlist gives the label, the command, the interval and the log', () => {
  const text = buildPlist({ node: '/usr/bin/node', bin: '/pkg/bin/relaylead.js', home: '/h', path: '/usr/bin:/bin', everySeconds: 300 });
  assert.match(text, /<string>dev\.relaylead\.watcher<\/string>/);
  assert.match(text, /<string>\/usr\/bin\/node<\/string>\s*<string>\/pkg\/bin\/relaylead\.js<\/string>\s*<string>watcher<\/string>\s*<string>run<\/string>/);
  assert.match(text, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
  assert.match(text, /<key>RunAtLoad<\/key>\s*<false\/>/);
  assert.ok(text.includes(path.join('/h', 'launchd.log')));
  assert.match(text, /<key>PATH<\/key>\s*<string>\/usr\/bin:\/bin<\/string>/);
  assert.doesNotMatch(text, /RELAYLEAD_HOME|API_KEY/);
});

test('buildPlist escapes & < > and sets RELAYLEAD_HOME when given', () => {
  const text = buildPlist({ node: '/n', bin: '/a & b/<x>/relaylead.js', home: '/h', path: '/p', relayleadHome: '/r&r', everySeconds: 60 });
  assert.match(text, /\/a &amp; b\/&lt;x&gt;\/relaylead\.js/);
  assert.match(text, /<key>RELAYLEAD_HOME<\/key>\s*<string>\/r&amp;r<\/string>/);
});

test('install writes the plist and loads it; a second install does not duplicate', (t) => {
  const state = setup(t);
  installScheduler();
  installScheduler();
  assert.deepStrictEqual(fs.readdirSync(process.env.RELAYLEAD_LAUNCHD_DIR), ['dev.relaylead.watcher.plist']);
  assert.deepStrictEqual(schedulerStatus(), { installed: true, loaded: true });
  const verbs = calls(state).map((args) => args[0]);
  assert.deepStrictEqual(verbs.slice(0, 4), ['bootout', 'bootstrap', 'bootout', 'bootstrap']);
});

test('uninstall removes the plist and unloads it; without a plist it does nothing', (t) => {
  const state = setup(t);
  assert.strictEqual(uninstallScheduler(), false);
  assert.ok(!fs.existsSync(path.join(state, 'calls.log')));
  installScheduler();
  assert.strictEqual(uninstallScheduler(), true);
  assert.ok(!fs.existsSync(plistPath()));
  assert.deepStrictEqual(schedulerStatus(), { installed: false, loaded: false });
});

test('on another platform, install and uninstall refuse with platform-unsupported', (t) => {
  setup(t);
  process.env.RELAYLEAD_PLATFORM = 'linux';
  assert.throws(() => installScheduler(), { code: 'platform-unsupported' });
  assert.throws(() => uninstallScheduler(), { code: 'platform-unsupported' });
});
