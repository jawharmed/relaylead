// `relaylead doctor`: the prerequisites and the state of the installation. Read only: it starts no session.
const fs = require('node:fs');
const path = require('node:path');
const { home } = require('./paths');
const { loadConfig, watcherSettings, DEFAULTS } = require('./config');
const { platform } = require('./platform');
const { schedulerStatus, readPlist } = require('./scheduler');
const { pluginInstalled, PLUGIN_ID } = require('./plugin');
const { checkVersion, authWithKeyFile } = require('../adapters/claude');
const { authSettings, apiKeyFileFound } = require('./auth');
const { t } = require('./messages');

const { watcherRunning } = require('./watcher');
const { runFileSync } = require('./run-file');
const { readMemory, memorySettings } = require('./memory');
const { listMissions } = require('./missions');
const { abandonment } = require('./abandon');
const { secureHome, readJson } = require('./store');

const MIN_NODE = 18;

// The settings a configuration file may hold: those of DEFAULTS, and `team`, written by init.
const KNOWN_KEYS = [...Object.keys(DEFAULTS), 'team'];

// Returns [{ level: 'ok' | 'warn' | 'fail', name, detail }].
// `dir` is the folder the command runs in: its project memory, when it has one, is checked too.
// The details are in `lang` ('en' or 'fr'); the names and levels stay as they are.
async function doctor(dir, lang) {
  const lines = [];
  const add = (level, name, detail) => lines.push({ level, name, detail });
  const say = (key, vars) => t(key, vars, lang);

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add(nodeMajor >= MIN_NODE ? 'ok' : 'fail', 'node', nodeMajor >= MIN_NODE ? process.versions.node : say('doctor-node-old', { found: process.versions.node, min: MIN_NODE }));

  let claudeFound = false;
  try {
    add('ok', 'claude', await checkVersion());
    claudeFound = true;
  } catch (err) {
    add('fail', 'claude', err.message);
  }

  try {
    runFileSync('git', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    add('ok', 'git', say('doctor-git-found'));
  } catch {
    add('fail', 'git', say('doctor-git-missing'));
  }

  if (platform() !== 'darwin') {
    add('warn', 'scheduler', say('doctor-scheduler-unsupported'));
  } else {
    const status = schedulerStatus();
    if (status.installed && status.loaded) add('ok', 'scheduler', say('doctor-scheduler-ok'));
    else if (status.installed) add('warn', 'scheduler', say('doctor-scheduler-not-loaded'));
    else add('warn', 'scheduler', say('doctor-scheduler-missing'));
    if (status.installed) checkPlist(add, say);
  }

  if (!claudeFound) {
    add('warn', 'plugin', say('doctor-plugin-unknown'));
  } else {
    try {
      if (pluginInstalled()) add('ok', 'plugin', PLUGIN_ID);
      else add('warn', 'plugin', say('doctor-plugin-missing'));
    } catch {
      add('warn', 'plugin', say('doctor-plugin-unreadable'));
    }
  }

  const { lastPassAt } = watcherRunning();
  if (!lastPassAt) {
    add('ok', 'watcher', say('doctor-watcher-none'));
  } else {
    const late = Date.now() - Date.parse(lastPassAt) > 3 * watcherSettings().everySeconds * 1000;
    add(late ? 'warn' : 'ok', 'watcher', say(late ? 'doctor-watcher-late' : 'doctor-watcher-pass', { at: lastPassAt }));
  }

  try {
    const config = loadConfig();
    const { mode, keyFile } = authSettings(config);
    if (mode === 'api-key') {
      const found = apiKeyFileFound(config);
      add(found ? 'ok' : 'fail', 'api-key', say(found ? 'doctor-api-key-found' : 'doctor-api-key-absent'));
      if (found && claudeFound) await checkApiKeyUse(keyFile, add, say);
    } else {
      add('ok', 'auth', say('doctor-auth-login'));
    }
  } catch (err) {
    add('fail', 'config', err.message);
  }

  checkConfigFile(path.join(home(), 'config.json'), add, say, { reportUnreadable: false });
  if (dir) checkConfigFile(path.join(dir, '.relaylead.json'), add, say, { reportUnreadable: true });

  if (dir) {
    try {
      const memory = memorySettings(dir).enabled ? readMemory(dir) : null;
      if (memory && memory.text !== '') {
        const over = memory.tooBig
          ? say('doctor-memory-too-big', { bytes: memory.bytes, max: memory.maxBytes })
          : say('doctor-memory-too-long', { lines: memory.lines, max: memory.maxLines });
        add(memory.tooLong ? 'warn' : 'ok', 'memory', memory.tooLong ? over : say('doctor-memory-ok', { lines: memory.lines, max: memory.maxLines }));
      }
    } catch (err) {
      add('warn', 'memory', say('doctor-memory-unreadable', { detail: err.message }));
    }
  }

  // Missions that wait for an answer while nothing moves (core/abandon.js): reported, never removed.
  try {
    for (const mission of listMissions()) {
      if (mission.unreadable) {
        add('warn', `mission ${mission.name}`, say('doctor-mission-unreadable', { dir: mission.dir }));
        continue;
      }
      const abandoned = abandonment(mission.name);
      if (abandoned) {
        add('warn', `mission ${mission.name}`, say('doctor-mission-abandoned', { days: abandoned.days, mission: mission.name }));
      }
    }
  } catch (err) {
    add('warn', 'missions', say('doctor-missions-unreadable', { detail: err.message }));
  }

  // RELAYLEAD_HOME for the user alone: a folder readable by others is put back in 700.
  try {
    const former = secureHome();
    if (former) add('ok', 'permissions', say('doctor-home-fixed', { dir: home(), mode: former }));
    else if (fs.existsSync(home()) && process.platform !== 'win32') add('ok', 'permissions', say('doctor-home-private', { dir: home() }));
  } catch (err) {
    add('warn', 'permissions', say('doctor-home-unfixed', { dir: home(), detail: err.message }));
  }

  if (fs.existsSync(path.join(home(), 'STOP'))) add('warn', 'STOP', say('doctor-stop', { home: home() }));
  return lines;
}

// What the plist froze at install must still be there: the Node that runs the watcher and the
// relaylead script (a Node updated by nvm, a package moved), and claude on its PATH, which the
// watcher uses to wake the leads (the plist passes no RELAYLEAD_CLAUDE).
function checkPlist(add, say) {
  const frozen = readPlist();
  if (!frozen) return;
  for (const file of [frozen.node, frozen.bin]) {
    if (file && !fs.existsSync(file)) add('warn', 'scheduler', say('doctor-plist-missing', { file }));
  }
  const found = frozen.path.split(path.delimiter).some((folder) => folder && fs.existsSync(path.join(folder, 'claude')));
  if (!found) add('warn', 'scheduler', say('doctor-plist-no-claude', { path: frozen.path }));
}

// Warnings for a configuration file: the settings relaylead does not know (ignored), and the values
// of language, permissionMode, parallel and maxSessions it cannot use. Nothing when the file is
// missing. An unreadable file is a fail when `reportUnreadable` (the machine file already has its
// line, from loadConfig above).
function checkConfigFile(file, add, say, { reportUnreadable }) {
  let config;
  try {
    config = readJson(file, null);
  } catch (err) {
    if (reportUnreadable) add('fail', 'config', err.message);
    return;
  }
  if (config === null) return;
  if (typeof config !== 'object' || Array.isArray(config)) {
    add('fail', 'config', say('doctor-config-not-object', { file }));
    return;
  }
  for (const key of Object.keys(config)) {
    if (!KNOWN_KEYS.includes(key)) add('warn', 'config', say('doctor-config-unknown-key', { file, key }));
  }
  const shown = (key) => JSON.stringify(config[key]);
  if ('language' in config && !['en', 'fr'].includes(config.language)) {
    add('warn', 'config', say('doctor-config-language', { file, value: shown('language') }));
  }
  if ('permissionMode' in config && !['allowlist', 'all'].includes(config.permissionMode)) {
    add('warn', 'config', say('doctor-config-permission-mode', { file, value: shown('permissionMode') }));
  }
  for (const key of ['parallel', 'maxSessions']) {
    if (key in config && !(Number.isInteger(config[key]) && config[key] >= 1)) {
      add('warn', 'config', say('doctor-config-whole-number', { file, key, value: shown(key) }));
    }
  }
}

// Asks claude which credential the sessions' apiKeyHelper gives it (adapters/claude), then says how
// to check a running session.
async function checkApiKeyUse(keyFile, add, say) {
  try {
    const { apiKeySource, authMethod } = await authWithKeyFile(keyFile);
    if (apiKeySource === 'apiKeyHelper') add('ok', 'api-key-use', say('doctor-key-use-ok'));
    else add('warn', 'api-key-use', say('doctor-key-use-other', { source: apiKeySource || authMethod || say('doctor-key-use-unknown') }));
  } catch (err) {
    add('warn', 'api-key-use', say('doctor-key-use-failed', { detail: err.message }));
  }
  add('ok', 'api-key-check', say('doctor-key-check'));
}

module.exports = { doctor };
