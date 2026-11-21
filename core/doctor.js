// `relaylead doctor`: the prerequisites and the state of the installation. Read only: it starts no session.
const fs = require('node:fs');
const path = require('node:path');
const { home } = require('./paths');
const { loadConfig, watcherSettings } = require('./config');
const { platform } = require('./platform');
const { schedulerStatus } = require('./scheduler');
const { pluginInstalled, PLUGIN_ID } = require('./plugin');
const { checkVersion, authWithKeyFile } = require('../adapters/claude');
const { authSettings, apiKeyFileFound } = require('./auth');

// How to see that a running session really uses the key, not the connected account.
const API_KEY_CHECK = 'in a running session (relaylead show <mission>), /status must name apiKeyHelper, not your Claude account';
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
    const { mode, keyFile } = authSettings(config);
    if (mode === 'api-key') {
      const found = apiKeyFileFound(config);
      add(found ? 'ok' : 'fail', 'api-key', found ? 'file found' : 'missing');
      if (found && claudeFound) await checkApiKeyUse(keyFile, add);
    } else {
      add('ok', 'auth', 'login (the connected Claude account)');
    }
  } catch (err) {
    add('fail', 'config', err.message);
  }

  if (fs.existsSync(path.join(home(), 'STOP'))) add('warn', 'STOP', `present in ${home()}: the watcher does nothing until it is removed`);
  return lines;
}

// Asks claude which credential the sessions' apiKeyHelper gives it (adapters/claude), then says how
// to check a running session.
async function checkApiKeyUse(keyFile, add) {
  try {
    const { apiKeySource, authMethod } = await authWithKeyFile(keyFile);
    if (apiKeySource === 'apiKeyHelper') add('ok', 'api-key-use', 'claude picks the key through apiKeyHelper');
    else add('warn', 'api-key-use', `claude would sign in with ${apiKeySource || authMethod || 'an unknown method'}, not the key`);
  } catch (err) {
    add('warn', 'api-key-use', `could not ask claude (${err.message})`);
  }
  add('ok', 'api-key-check', API_KEY_CHECK);
}

module.exports = { doctor };
