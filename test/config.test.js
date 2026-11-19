const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, watcherSettings, resolveSecret, DEFAULTS } = require('../core/config');
const { writeJson } = require('../core/store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relaylead-config-'));
}

test('project config overrides machine config, params override both', () => {
  const home = tmpDir();
  const project = tmpDir();
  process.env.RELAYLEAD_HOME = home;
  writeJson(path.join(home, 'config.json'), { parallel: 2, language: 'fr', questions: { onTimeout: 'skip' } });
  writeJson(path.join(project, '.relaylead.json'), { parallel: 3, guard: { allow: ['npm test'] } });
  const config = loadConfig({ dir: project, params: { parallel: 9 } });
  assert.strictEqual(config.parallel, 9);
  assert.strictEqual(config.language, 'fr');
  assert.strictEqual(config.questions.onTimeout, 'skip');
  assert.deepStrictEqual(config.guard.allow, ['npm test']);
  assert.deepStrictEqual(config.guard.protectedBranches, ['main', 'master']);
  assert.strictEqual(config.agent, DEFAULTS.agent);
});

test('loadConfig works when no config file exists', () => {
  process.env.RELAYLEAD_HOME = tmpDir();
  assert.deepStrictEqual(loadConfig({ dir: tmpDir() }), DEFAULTS);
});

test('watcherSettings reads the machine file, and RELAYLEAD_WATCHER=off turns the loop and helpers off', (t) => {
  const home = tmpDir();
  process.env.RELAYLEAD_HOME = home;
  const saved = process.env.RELAYLEAD_WATCHER;
  t.after(() => {
    if (saved === undefined) delete process.env.RELAYLEAD_WATCHER;
    else process.env.RELAYLEAD_WATCHER = saved;
  });
  delete process.env.RELAYLEAD_WATCHER;
  assert.deepStrictEqual(watcherSettings(), { autoStart: true, helpers: true, everySeconds: 300 });
  writeJson(path.join(home, 'config.json'), { watcher: { autoStart: false, everySeconds: 60 } });
  assert.deepStrictEqual(watcherSettings(), { autoStart: false, helpers: true, everySeconds: 60 });
  for (const everySeconds of [0, 1.5, '10', null]) {
    writeJson(path.join(home, 'config.json'), { watcher: { everySeconds } });
    assert.strictEqual(watcherSettings().everySeconds, 300, JSON.stringify(everySeconds));
  }
  process.env.RELAYLEAD_WATCHER = 'off';
  assert.deepStrictEqual(watcherSettings(), { autoStart: false, helpers: false, everySeconds: 300 });
});

test('resolveSecret reads env: and file: references', () => {
  process.env.RELAYLEAD_TEST_SECRET = 'from-env';
  assert.strictEqual(resolveSecret('env:RELAYLEAD_TEST_SECRET'), 'from-env');
  const file = path.join(tmpDir(), 'secret.txt');
  fs.writeFileSync(file, 'from-file\n');
  assert.strictEqual(resolveSecret('file:' + file), 'from-file');
});

test('resolveSecret rejects a plain secret value', () => {
  assert.throws(() => resolveSecret('sk-123456'), /secrets must be references/);
});
