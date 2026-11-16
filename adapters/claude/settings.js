// The per-session settings file passed to `claude --settings`: environment, hooks, attribution.
const fs = require('node:fs');
const path = require('node:path');
const { home, missionDir } = require('../../core/paths');
const { writeJson, writeText } = require('../../core/store');
const { allowedTools } = require('./args');

// Same shape as the spike settings (no matcher). Double quotes: the paths may contain spaces (Windows included).
function hookEntry(packageDir, script) {
  const file = path.join(packageDir, 'core', 'hooks', `${script}.js`);
  return [{ hooks: [{ type: 'command', command: `"${process.execPath}" "${file}"` }] }];
}

// Where the mission's `relaylead` shim lives; it comes first on the session's PATH.
function binDir(missionName) {
  return path.join(missionDir(missionName), 'bin');
}

// For sh, single quotes keep every character as it is; a single quote itself is written '\''.
function shQuote(text) {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

// Written only when it changes, and through a rename (writeText): a session may be running it right now.
function writeExecutable(file, text) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return;
  writeText(file, text, { mode: 0o755 });
}

// The `relaylead` the sessions' commands run, whatever the user's PATH holds: this very package,
// with this very Node. On Windows, `relaylead` serves Git Bash and `relaylead.cmd` the other shells.
function writeCliShim(missionName, packageDir) {
  const dir = binDir(missionName);
  const script = path.join(packageDir, 'bin', 'relaylead.js');
  fs.mkdirSync(dir, { recursive: true });
  writeExecutable(path.join(dir, 'relaylead'), `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(script)} "$@"\n`);
  if (process.platform === 'win32') {
    writeExecutable(path.join(dir, 'relaylead.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
  }
}

// Pure: builds the settings object, writes nothing. `env` is the session's own environment (a
// background session does not inherit the launcher's); the fixed keys below win over it.
function sessionSettings({ mission, packageDir, profile, permissionMode, env = {} }) {
  const settings = {
    env: {
      ...env,
      RELAYLEAD_MISSION: mission.name,
      RELAYLEAD_HOME: home(),
      PATH: binDir(mission.name) + path.delimiter + (process.env.PATH || ''),
      BASH_DEFAULT_TIMEOUT_MS: '600000',
      RELAYLEAD_ALLOW: JSON.stringify(allowedTools(profile, permissionMode)),
    },
    hooks: {
      PreToolUse: hookEntry(packageDir, 'pretool'),
      PermissionRequest: hookEntry(packageDir, 'permission'),
    },
  };
  // A background session does not inherit the launcher's environment.
  if (process.env.RELAYLEAD_WRITE_RETRY_MS !== undefined) {
    settings.env.RELAYLEAD_WRITE_RETRY_MS = process.env.RELAYLEAD_WRITE_RETRY_MS;
  }
  if (mission.config.attribution != null) settings.attribution = mission.config.attribution;
  return settings;
}

// Writes missions/<mission>/settings/<session name, "/" as "-">.json, and the shim its PATH names,
// and returns the settings file's path.
function writeSessionSettings({ mission, packageDir, profile, permissionMode, sessionName, env }) {
  writeCliShim(mission.name, packageDir);
  const file = path.join(missionDir(mission.name), 'settings', `${sessionName.replace(/\//g, '-')}.json`);
  writeJson(file, sessionSettings({ mission, packageDir, profile, permissionMode, env }));
  return file;
}

module.exports = { sessionSettings, writeSessionSettings };
