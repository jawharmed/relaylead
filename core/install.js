// `relaylead install` and `uninstall`: the only commands that write outside ~/.relaylead.
// What was added is noted in ~/.relaylead/install.json, so uninstall removes exactly that.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { home } = require('./paths');
const { readJson, writeJson, secureHome } = require('./store');
const { assertSupported } = require('./platform');
const { installScheduler, uninstallScheduler, plistPath, LABEL } = require('./scheduler');
const { installPlugin, uninstallPlugin, removePluginCache, PLUGIN_ID, MARKETPLACE } = require('./plugin');
const { codedError } = require('./messages');
const { watcherRunning, stopWatcher } = require('./watcher');
const { listMissions, stopMission } = require('./missions');

// How long uninstall waits for the watcher's loop to end its pass.
const LOOP_END_WAIT_MS = 120000;

const installFile = () => path.join(home(), 'install.json');

const MARKER = '.relaylead-home';

// Installs the scheduler, then the plugin. `say(key, vars)` reports each step. Safe to run again.
// Without claude the plugin is skipped and the rest goes on. What each step adds is noted in
// install.json as soon as it is done, so uninstall can undo a partial install.
function install(say) {
  assertSupported();
  // For the user alone; a folder made by an older version is put back in 700.
  fs.mkdirSync(home(), { recursive: true, mode: 0o700 });
  secureHome();
  // Tells --purge that this folder is relaylead's.
  fs.writeFileSync(path.join(home(), MARKER), '', { mode: 0o600 });
  const previous = readJson(installFile(), {});
  const record = { installedAt: new Date().toISOString(), scheduler: previous.scheduler || null, plugin: previous.plugin || null };
  const save = () => writeJson(installFile(), record);

  const file = installScheduler();
  record.scheduler = { plist: file };
  save();
  say('scheduler-installed', { file });

  try {
    installPlugin((step) => {
      record.plugin = { ...record.plugin, ...(step === 'marketplace' ? { marketplace: MARKETPLACE } : { id: PLUGIN_ID }) };
      save();
    });
    say('plugin-installed', { id: PLUGIN_ID });
  } catch (err) {
    if (err.code !== 'claude-not-found') throw err;
    say('plugin-skipped', {});
  }
}

// Undoes what install.json lists; without it, what is found (the plist, the plugin). Every step is
// independent: a failure is a warning with the command to run by hand, and the next steps go on.
// With `purge`, also deletes ~/.relaylead, but only if it is a relaylead folder (checked first), and
// only once every mission is over: their sessions would go on with no watcher and no guard. The
// missions not over are named; with `force`, their sessions are stopped first.
// First of all, the watcher's loop (started by launch) is stopped and waited for: left running, it
// would go on from the package being removed, and write its file again in a purged home.
async function uninstall(say, { purge = false, force = false } = {}) {
  assertSupported();
  const record = readJson(installFile(), null);
  if (purge && !isRelayleadHome(record)) throw codedError('purge-refused', { dir: home() });
  const active = purge ? missionsNotOver(force) : [];
  if (watcherRunning().running) {
    const outcome = await stopWatcher({ waitMs: LOOP_END_WAIT_MS });
    if (outcome === 'requested') say('uninstall-warning', { step: 'watcher', detail: 'its loop is still in a pass', command: 'relaylead watcher stop' });
    else say('watcherStopped', {});
  }
  // After the watcher's loop: no pass of it runs while the missions are stopped.
  await stopMissions(active, say);
  if (!record) say('nothing-installed', {});

  if (!record || record.scheduler) {
    try {
      if (uninstallScheduler()) say('scheduler-removed', {});
    } catch (err) {
      say('uninstall-warning', { step: 'scheduler', detail: err.message, command: `launchctl bootout gui/${process.getuid ? process.getuid() : 0}/${LABEL}` });
    }
  }
  if (!record || record.plugin) {
    const failures = uninstallPlugin();
    for (const failure of failures) say('uninstall-warning', failure);
    if (failures.length === 0) say('plugin-removed', { id: PLUGIN_ID });
  }
  fs.rmSync(installFile(), { force: true });
  if (purge) {
    removePluginCache();
    fs.rmSync(home(), { recursive: true, force: true });
    say('purged', { dir: home() });
  }
}

// A mission is over once done or stopped, and its sessions stopped (not "done, stopping"). An
// unreadable one may still run: it counts as not over.
function notOver(mission) {
  return !/^(done|stopped)/.test(mission.state) || mission.state.endsWith(', stopping');
}

// The names of the missions not over. Refused unless `force`: nothing is changed before that check.
function missionsNotOver(force) {
  const names = listMissions().filter(notOver).map((mission) => mission.name);
  if (names.length > 0 && !force) throw codedError('purge-active-missions', { missions: names.join(', '), dir: home() });
  return names;
}

// Stops each mission. A stop that fails is a warning with the command to run by hand, and the purge goes on.
async function stopMissions(names, say) {
  for (const name of names) {
    try {
      await stopMission(name);
      say('missionStopped', { mission: name });
    } catch (err) {
      say('uninstall-warning', { step: `sessions of mission ${name}`, detail: err.message, command: `relaylead stop ${name}` });
    }
  }
}

// A relaylead folder: the default one, one install marked, or one with an install.json.
function isRelayleadHome(record) {
  const dir = home();
  if (!path.isAbsolute(dir) || dir === os.homedir() || dir === path.parse(dir).root) return false;
  return path.basename(dir) === '.relaylead' || Boolean(record) || fs.existsSync(path.join(dir, MARKER));
}

module.exports = { install, uninstall, plistPath };
