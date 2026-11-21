// `relaylead install` and `uninstall`: the only commands that write outside ~/.relaylead.
// What was added is noted in ~/.relaylead/install.json, so uninstall removes exactly that.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { home } = require('./paths');
const { readJson, writeJson } = require('./store');
const { assertSupported } = require('./platform');
const { installScheduler, uninstallScheduler, plistPath } = require('./scheduler');
const { installPlugin, uninstallPlugin, PLUGIN_ID } = require('./plugin');
const { codedError } = require('./messages');

const installFile = () => path.join(home(), 'install.json');

// Installs the scheduler, then the plugin. `say(key, vars)` reports each step. Safe to run again.
// Without claude the plugin is skipped and the rest goes on.
function install(say) {
  assertSupported();
  fs.mkdirSync(home(), { recursive: true });
  const previous = readJson(installFile(), {});
  const record = { installedAt: new Date().toISOString(), scheduler: previous.scheduler || null, plugin: previous.plugin || null };

  const file = installScheduler();
  record.scheduler = { plist: file };
  writeJson(installFile(), record);
  say('scheduler-installed', { file });

  try {
    installPlugin();
    record.plugin = { id: PLUGIN_ID };
    writeJson(installFile(), record);
    say('plugin-installed', { id: PLUGIN_ID });
  } catch (err) {
    if (err.code !== 'claude-not-found') throw err;
    say('plugin-skipped', {});
  }
}

// Undoes what install.json lists. With `purge`, also deletes ~/.relaylead.
function uninstall(say, { purge = false } = {}) {
  assertSupported();
  const record = readJson(installFile(), null);
  if (!record) {
    say('nothing-installed', {});
  } else {
    if (record.scheduler) {
      uninstallScheduler();
      writeJson(installFile(), { ...record, scheduler: null });
      say('scheduler-removed', {});
    }
    if (record.plugin) {
      uninstallPlugin();
      say('plugin-removed', { id: PLUGIN_ID });
    }
    fs.rmSync(installFile(), { force: true });
  }
  if (purge) purgeHome(say);
}

// Deletes the home folder, after checking it is a folder of relaylead's and not the user's home or a root.
function purgeHome(say) {
  const dir = home();
  if (!path.isAbsolute(dir) || dir === os.homedir() || dir === path.parse(dir).root) throw codedError('purge-refused', { dir });
  fs.rmSync(dir, { recursive: true, force: true });
  say('purged', { dir });
}

module.exports = { install, uninstall, plistPath };
