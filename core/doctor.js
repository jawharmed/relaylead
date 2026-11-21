// `relaylead doctor`: the prerequisites and the state of the installation. Read only: it starts no session.
const fs = require('node:fs');
const path = require('node:path');
const { home } = require('./paths');
const { loadConfig, watcherSettings } = require('./config');
const { platform } = require('./platform');
const { schedulerStatus } = require('./scheduler');
const { pluginInstalled, PLUGIN_ID } = require('./plugin');
const { checkVersion } = require('../adapters/claude');
const { authSettings, apiKeyFileFound } = require('./auth');
const { watcherRunning } = require('./watcher');
const { runFileSync } = require('./run-file');

const MIN_NODE = 18;

// Returns [{ level: 'ok' | 'warn' | 'fail', name, detail }].
async function doctor() {
  const lines = [];
  const add = (level, name, detail) => lines.push({ level, name, detail });

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add(nodeMajor >= MIN_NODE ? 'ok' : 'fail', 'node', nodeMajor >= MIN_NODE ? process.versions.node : `${process.versions.node}, Node ${MIN_NODE} or later is needed`);

  let claudeFound = false;
  try {
    add('ok', 'claude', await checkVersion());
    claudeFound = true;
  } catch (err) {
    add('fail', 'claude', err.message);
  }

  try {
    runFileSync('git', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    add('ok', 'git', 'found');
  } catch {
    add('fail', 'git', 'not found');
  }

  if (platform() !== 'darwin') {
    add('warn', 'scheduler', 'unsupported platform');
  } else {
    const status = schedulerStatus();
    if (status.installed && status.loaded) add('ok', 'scheduler', 'installed and loaded');
    else if (status.installed) add('warn', 'scheduler', 'installed but not loaded; run: relaylead install');
    else add('warn', 'scheduler', 'not installed; run: relaylead install');
  }

  if (!claudeFound) {
    add('warn', 'plugin', 'unknown, claude is not usable');
  } else {
    try {
      if (pluginInstalled()) add('ok', 'plugin', PLUGIN_ID);
      else add('warn', 'plugin', 'not installed; run: relaylead install');
    } catch {
      add('warn', 'plugin', 'could not read the list of plugins');
    }
  }

  const { lastPassAt } = watcherRunning();
  if (!lastPassAt) {
    add('ok', 'watcher', 'no pass recorded yet');
  } else {
    const late = Date.now() - Date.parse(lastPassAt) > 3 * watcherSettings().everySeconds * 1000;
    add(late ? 'warn' : 'ok', 'watcher', `last pass ${lastPassAt}` + (late ? ', more than 3 intervals ago' : ''));
  }

  try {
    const config = loadConfig();
    if (authSettings(config).mode === 'api-key') {
      const found = apiKeyFileFound(config);
      add(found ? 'ok' : 'fail', 'api-key', found ? 'file found' : 'missing');
    } else {
      add('ok', 'auth', 'login (the connected Claude account)');
    }
  } catch (err) {
    add('fail', 'config', err.message);
  }

  if (fs.existsSync(path.join(home(), 'STOP'))) add('warn', 'STOP', `present in ${home()}: the watcher does nothing until it is removed`);
  return lines;
}

module.exports = { doctor };
