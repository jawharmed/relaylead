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
const { listMissions, stopMission, stopSessionsAndWait } = require('./missions');
const { mergeOngoing } = require('./merge');
const { missionDir } = require('./paths');
const { getAdapter } = require('../adapters');
const { DEFAULTS } = require('./config');

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
    const result = installPlugin((step) => {
      record.plugin = { ...record.plugin, ...(step === 'marketplace' ? { marketplace: MARKETPLACE } : { id: PLUGIN_ID }) };
      save();
    });
    if (result.updated) say('plugin-updated', { id: PLUGIN_ID, from: result.from, to: result.to });
    else say('plugin-installed', { id: PLUGIN_ID });
  } catch (err) {
    if (err.code !== 'claude-not-found') throw err;
    say('plugin-skipped', {});
  }
}

// Undoes what install.json lists; without it, what is found (the plist, the plugin). Every step is
// independent: a failure is a warning with the command to run by hand, and the next steps go on.
// With `purge`, also deletes ~/.relaylead, but only if it is a relaylead folder (checked first), and
// only once no mission has sessions left: they would go on with no watcher and no guard. Those
// missions are named and nothing is changed; with `force`, their sessions are stopped first, once
// the watcher's loop has ended, and a stop that fails keeps everything in place.
// First of all, the watcher's loop (started by launch) is stopped and waited for: left running, it
// would go on from the package being removed, and write its file again in a purged home.
async function uninstall(say, { purge = false, force = false } = {}) {
  assertSupported();
  const record = readJson(installFile(), null);
  if (purge && !isRelayleadHome(record)) throw codedError('purge-refused', { dir: home() });
  if (purge && !force) refuseWhileRunning();
  if (watcherRunning().running) {
    const outcome = await stopWatcher({ waitMs: LOOP_END_WAIT_MS });
    if (outcome === 'requested') say('uninstall-warning', { step: 'watcher', detail: 'its loop is still in a pass', command: 'relaylead watcher stop' });
    else say('watcherStopped', {});
  }
  // Read again once the loop has ended: a mission launched meanwhile, or a merge resolution started
  // by its last pass, is stopped too.
  if (purge && force) await stopMissions(missionsToStop(), say);
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

// The missions that may still have sessions, as {name, unreadable, merging}: those not over (a
// state other than done or stopped, or "…, stopping"), the unreadable ones, and the done ones whose
// merge conflict a crew member is resolving (core/merge.js).
function missionsToStop() {
  return listMissions()
    .map((mission) => ({ name: mission.name, unreadable: Boolean(mission.unreadable), over: /^(done|stopped)/.test(mission.state) && !mission.state.endsWith(', stopping') }))
    .map((mission) => ({ ...mission, merging: mission.over && !mission.unreadable && mergeOngoing(mission.name) }))
    .filter((mission) => mission.unreadable || !mission.over || mission.merging);
}

function refuseWhileRunning() {
  const names = missionsToStop().map((mission) => mission.name);
  if (names.length > 0) throw codedError('purge-active-missions', { missions: names.join(', '), dir: home() });
}

// Stops the sessions of each mission. A mission not over is stopped as `relaylead stop` does. For
// the others, stopMission would do nothing (a done mission) or cannot read the mission (unreadable):
// the sessions the agent still lists as running are stopped directly, with the mission's agent, or
// the default one when mission.json cannot be read. When a stop fails, nothing is deleted: the
// missions are named and the command fails.
async function stopMissions(missions, say) {
  const failed = [];
  for (const mission of missions) {
    try {
      if (mission.unreadable || mission.merging) await stopListedSessions(mission.name);
      else await stopMission(mission.name);
      say('missionStopped', { mission: mission.name });
    } catch (err) {
      failed.push({ name: mission.name, detail: err.message });
    }
  }
  if (failed.length > 0) {
    throw codedError('purge-stop-failed', { missions: failed.map((one) => `${one.name} (${one.detail})`).join(', '), dir: home() });
  }
}

async function stopListedSessions(name) {
  let mission = null;
  try {
    mission = readJson(path.join(missionDir(name), 'mission.json'), null);
  } catch {
    // unreadable: the default agent
  }
  const known = mission && typeof mission === 'object' && typeof mission.agent === 'string' ? mission.agent : DEFAULTS.agent;
  const target = { name, agent: known };
  const rows = await getAdapter(target.agent).list(name);
  const running = rows.filter((row) => row.pid);
  const { failed, alive, error } = await stopSessionsAndWait(target, running);
  if (failed.length > 0 || alive.length > 0) throw error || new Error(`${alive.length} session(s) still running`);
}

// A relaylead folder: the default one, one install marked, or one with an install.json.
function isRelayleadHome(record) {
  const dir = home();
  if (!path.isAbsolute(dir) || dir === os.homedir() || dir === path.parse(dir).root) return false;
  return path.basename(dir) === '.relaylead' || Boolean(record) || fs.existsSync(path.join(dir, MARKER));
}

module.exports = { install, uninstall, plistPath };
