// How claude signs in. In `api-key` mode the key lives in a file (never in the configuration, a plist
// or a log), so the watcher, started by launchd without any environment, finds it too.
// This file is the only reader of the key: nothing here prints it. The sessions get it from Claude
// Code's `apiKeyHelper` setting (adapters/claude/settings.js), which runs core/api-key-helper.js: the
// key itself is never in an argument, an environment variable or a settings file.
const fs = require('node:fs');
const path = require('node:path');
const { home } = require('./paths');
const { writeText } = require('./store');
const { codedError } = require('./messages');

function authSettings(config) {
  const auth = (config && config.auth) || {};
  return { mode: auth.mode === 'api-key' ? 'api-key' : 'login', keyFile: auth.keyFile || path.join(home(), 'api-key') };
}

function readKey(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

// The key file the sessions read in `api-key` mode, null in `login` mode. Fails when it is missing
// or empty, so a launch does not start a session that would have no key.
function apiKeyFile(config) {
  const { mode, keyFile } = authSettings(config);
  if (mode !== 'api-key') return null;
  if (!readKey(keyFile)) throw codedError('api-key-missing', { file: keyFile });
  return keyFile;
}

// For doctor: whether the key file is there and not empty. Never its value.
function apiKeyFileFound(config) {
  return readKey(authSettings(config).keyFile) !== '';
}

// Copies the value of an environment variable into the key file, readable by its owner only.
// Returns the file's path.
function importApiKey(name, env, file) {
  const key = String(env[name] || '').trim();
  if (!key) throw codedError('api-key-env-empty', { name });
  writeText(file, key + '\n', { mode: 0o600 });
  return file;
}

module.exports = { authSettings, readKey, apiKeyFile, apiKeyFileFound, importApiKey };
