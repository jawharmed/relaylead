// The per-session settings file passed to `claude --settings`: environment, hooks, attribution.
const path = require('node:path');
const { home, missionDir } = require('../../core/paths');
const { writeJson } = require('../../core/store');
const { allowedTools } = require('./args');

// Same shape as the spike settings (no matcher). Double quotes: the paths may contain spaces (Windows included).
function hookEntry(packageDir, script) {
  const file = path.join(packageDir, 'core', 'hooks', `${script}.js`);
  return [{ hooks: [{ type: 'command', command: `"${process.execPath}" "${file}"` }] }];
}

// Pure: builds the settings object, writes nothing. `env` is the session's own environment (a
// background session does not inherit the launcher's); the fixed keys below win over it.
function sessionSettings({ mission, packageDir, profile, permissionMode, env = {} }) {
  const settings = {
    env: {
      ...env,
      RELAYLEAD_MISSION: mission.name,
      RELAYLEAD_HOME: home(),
      BASH_DEFAULT_TIMEOUT_MS: '600000',
      RELAYLEAD_ALLOW: JSON.stringify(allowedTools(profile, permissionMode)),
    },
    hooks: {
      PreToolUse: hookEntry(packageDir, 'pretool'),
      PermissionRequest: hookEntry(packageDir, 'permission'),
    },
  };
  if (mission.config.attribution != null) settings.attribution = mission.config.attribution;
  return settings;
}

// Writes missions/<mission>/settings/<session name, "/" as "-">.json and returns its path.
function writeSessionSettings({ mission, packageDir, profile, permissionMode, sessionName, env }) {
  const file = path.join(missionDir(mission.name), 'settings', `${sessionName.replace(/\//g, '-')}.json`);
  writeJson(file, sessionSettings({ mission, packageDir, profile, permissionMode, env }));
  return file;
}

module.exports = { sessionSettings, writeSessionSettings };
