const path = require('node:path');
const { t, codedError } = require('./messages');
const { loadConfig, watcherSettings } = require('./config');
const {
  createMission,
  listMissions,
  stopMission,
  removeMission,
  readMission,
  getState,
  setState,
  currentLeadError,
  reapLead,
  markReaperEnded,
  attachLead,
} = require('./missions');
const { listTasks, startTask, retryTask, deliverTask, finishTask } = require('./tasks');
const { waitForChanges } = require('./wait');
const { askQuestion, answerQuestion, listQuestions } = require('./questions');
const { runPass, tendMission, stopPresent, loop, watcherRunning, startWatcher, stopWatcher } = require('./watcher');
const { watchLogSize, watchLogSince } = require('./watch-log');
const { home } = require('./paths');
const { readPause, localTime, refuseWhilePaused } = require('./usage-pause');
const detached = require('./detached');
const { install, uninstall } = require('./install');
const { doctor } = require('./doctor');
const { init } = require('./init');
const pkg = require('../package.json');

// Options that take no value.
const FLAGS = ['all', 'force', 'no-hooks', 'purge', 'yes'];

// Splits arguments into positional values and `--name value` (or `--name=value`) options.
// A repeated option (--option a --option b) is also kept in full in `lists`.
function parseArgs(args) {
  const positional = [];
  const options = {};
  const lists = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const equals = args[i].indexOf('=');
      const name = equals === -1 ? args[i].slice(2) : args[i].slice(2, equals);
      if (FLAGS.includes(name)) {
        options[name] = true;
        continue;
      }
      let value;
      if (equals !== -1) {
        value = args[i].slice(equals + 1);
      } else {
        if (i + 1 >= args.length) throw codedError('missing-value', { name });
        value = args[i + 1];
        i++;
      }
      options[name] = value;
      (lists[name] = lists[name] || []).push(value);
    } else {
      positional.push(args[i]);
    }
  }
  return { positional, options, lists };
}

// True when an argument is `--help` or `-h` without being the value of the option before it
// (`--note --help` is a note). As in parseArgs, an option takes the next argument as its value
// when it starts with `--`, has no `=` and is not a flag.
function wantsHelp(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') return true;
    if (args[i].startsWith('--') && !args[i].includes('=') && !FLAGS.includes(args[i].slice(2))) i++;
  }
  return false;
}

function language(io) {
  try {
    return loadConfig({ dir: io.cwd }).language;
  } catch {
    return 'en';
  }
}

// Every session of a mission (lead or crew) runs with RELAYLEAD_MISSION set. Some commands belong
// to the user alone.
function refuseInSession(command, io) {
  if (io.env.RELAYLEAD_MISSION) throw codedError('not-from-a-session', { command });
}

// A lead replaced by a relaunch or a handover may still run commands: those that drive the mission
// are refused to it (currentLeadError). A crew member or the user is not checked.
function refuseReplacedLead(mission, io) {
  const refused = currentLeadError(mission, io.env);
  if (refused) throw refused;
}

// A targeted pass of the watcher over one mission, detached, so the command returns at once: it wakes
// a lead that has ended its turn. Off when watcher.helpers is false (or RELAYLEAD_WATCHER is off).
// spawnDetached is read from the module object, so a test can replace it; a failed start is ignored
// (the loop catches up).
async function startTargetedPass(mission) {
  try {
    if (!watcherSettings().helpers) return;
    await detached.spawnDetached(['watcher', 'run', '--mission', mission]);
  } catch {
    // the loop catches up
  }
}

// Each sub-command is (args, io) -> Promise<exit code>.
const commands = {};

commands.launch = async (args, io) => {
  refuseInSession('launch', io);
  const { options } = parseArgs(args);
  const mission = await createMission({
    name: options.name,
    dir: path.resolve(io.cwd, options.dir || '.'),
    request: options.request,
    team: options.team,
    priority: options.priority,
    agent: options.agent,
  });
  io.out.write(mission.name + '\n');
  await startWatcherAfterLaunch(io);
  return 0;
};

// The loop of the watcher, started by launch unless watcher.autoStart is false (or RELAYLEAD_WATCHER
// is off). It runs on its own, unasked: it says so on stderr, where the mission's name, alone on
// stdout, is not mixed with it. A loop that could not be started does not fail the launch.
async function startWatcherAfterLaunch(io) {
  const lang = language(io);
  try {
    const settings = watcherSettings();
    if (!settings.autoStart) return;
    if ((await startWatcher()) === 'started') io.err.write(t('watcherStarted', { seconds: settings.everySeconds }, lang));
  } catch (err) {
    const detail = err.vars ? t(err.code, err.vars, lang) : err.message;
    io.err.write(t('watcherNotStarted', { detail }, lang));
  }
}

commands.list = async (args, io) => {
  const missions = listMissions();
  if (missions.length === 0) io.out.write(t('noMissions', {}, language(io)));
  for (const mission of missions) {
    const lead = mission.lead ? mission.lead.sessionName : '-';
    io.out.write(`${mission.name}  ${shownState(mission.name, mission.state, io)}  ${lead}  ${mission.dir}\n`);
  }
  return 0;
};

// The state of a mission as the user sees it: that of its lead, or its pause for the usage limit
// (left alone once the mission is done or stopped).
function shownState(name, state, io) {
  const pause = /^(done|stopped)/.test(state) ? null : readPause(name);
  return pause ? t('usagePausedState', { resumeAt: localTime(pause.resumeAt) }, language(io)) : state;
}

// A mission paused for the usage limit says so before its lead's session is shown: that session is
// stopped once the lead has pushed its work.
commands.show = async (args, io) => {
  const [name] = parseArgs(args).positional;
  if (!name) throw codedError('usage', { usage: 'relaylead show <mission>' });
  const state = getState(name);
  // The listed state carries the note of a stop by the watcher (billing, authentication, relaunches).
  const listed = listMissions().find((mission) => mission.name === name);
  const shown = shownState(name, listed ? listed.state : state, io);
  if (shown !== state) io.out.write(`${name}  ${shown}\n`);
  return attachLead(name);
};

commands.stop = async (args, io) => {
  refuseInSession('stop', io);
  const [name] = parseArgs(args).positional;
  if (!name) throw codedError('usage', { usage: 'relaylead stop <mission>' });
  // The worktrees kept by the cleanup are reported even when the stop failed.
  const warn = (warnings) => {
    for (const warning of warnings || []) io.err.write(`relaylead stop: ${t(warning.code, warning.vars, language(io))}\n`);
  };
  let result;
  try {
    result = await stopMission(name);
  } catch (err) {
    warn(err.warnings);
    throw err;
  }
  warn(result.warnings);
  const { outcome } = result;
  if (outcome === 'stopped') io.out.write(t('missionStopped', { mission: name }, language(io)));
  else if (outcome === 'already-done') io.out.write(t('missionDoneSessionsStopped', { mission: name }, language(io)));
  else if (outcome === 'skipped') io.out.write(t('missionStopSkipped', { mission: name }, language(io)));
  else io.out.write(t('missionNothingToStop', { mission: name, state: getState(name) }, language(io)));
  return 0;
};

commands.remove = async (args, io) => {
  refuseInSession('remove', io);
  const { positional, options } = parseArgs(args);
  const [name] = positional;
  if (!name) throw codedError('usage', { usage: 'relaylead remove <mission> [--force]' });
  // Printed as soon as it is deleted, even if a later step fails: with its last commit, a deleted
  // branch can be made again (git branch <name> <sha>).
  const onBranchDeleted = (branch) => io.out.write(t('branchDeleted', { branch }, language(io)));
  await removeMission(name, { force: options.force === true, onBranchDeleted });
  io.out.write(t('missionRemoved', { mission: name }, language(io)));
  return 0;
};

// Sessions find their mission in RELAYLEAD_MISSION; a person passes --mission.
function missionName(options, io) {
  const mission = options.mission || io.env.RELAYLEAD_MISSION;
  if (!mission) throw codedError('no-mission', {});
  return mission;
}

commands.state = async (args, io) => {
  const { positional, options } = parseArgs(args);
  const [action, state] = positional;
  if (action !== 'get' && !(action === 'set' && state)) {
    throw codedError('usage', { usage: 'relaylead state get|set <state> [--note text] [--mission name]' });
  }
  const mission = missionName(options, io);
  if (action === 'get') {
    io.out.write(getState(mission) + '\n');
  } else {
    refuseReplacedLead(mission, io);
    const outcome = await setState(mission, state, options.note, { by: io.env.RELAYLEAD_SESSION || 'user' });
    if (outcome === 'skipped') io.out.write(t('missionStopSkipped', { mission }, language(io)));
    // The watcher stops the old lead and starts the next one at once.
    if (state === 'handover') await startTargetedPass(mission);
  }
  return 0;
};

commands.task = async (args, io) => {
  const { positional, options } = parseArgs(args);
  const [action, id] = positional;
  if (!(action === 'list' || (['start', 'retry', 'deliver', 'done', 'fail'].includes(action) && id))) {
    throw codedError('usage', {
      usage:
        'relaylead task list | start <id> [--profile p] | retry <id> [--profile p] | deliver <id> [--no-hooks] | done <id> | fail <id> [--summary text] [--mission name]',
    });
  }
  // A crew member runs with RELAYLEAD_TASK set: it finishes its own task and drives no other.
  const own = io.env.RELAYLEAD_TASK;
  if (own && ['start', 'retry', 'deliver'].includes(action)) throw codedError('not-for-crew', { own });
  if (own && ['done', 'fail'].includes(action) && id !== own) throw codedError('not-your-task', { own, id });
  // The configuration is frozen in mission.json: only the user may deliver without the git hooks.
  if (action === 'deliver' && options['no-hooks']) refuseInSession('task deliver --no-hooks', io);
  const mission = missionName(options, io);
  if (['start', 'retry', 'deliver'].includes(action)) refuseReplacedLead(mission, io);
  if (['start', 'retry'].includes(action)) refuseWhilePaused(mission);
  if (action === 'list') {
    io.out.write(JSON.stringify(listTasks(mission), null, 2) + '\n');
  } else if (action === 'start') {
    const record = await startTask(mission, { id, profile: options.profile, env: io.env });
    io.out.write(JSON.stringify(record, null, 2) + '\n');
  } else if (action === 'retry') {
    const record = await retryTask(mission, { id, profile: options.profile, env: io.env });
    io.out.write(JSON.stringify(record, null, 2) + '\n');
  } else if (action === 'deliver') {
    const runHooks = options['no-hooks'] ? false : undefined;
    const { outcome, warnings } = await deliverTask(mission, id, { runHooks, env: io.env });
    for (const warning of warnings) io.err.write(`relaylead task: ${t(warning.code, warning.vars, language(io))}\n`);
    io.out.write(t(outcome === 'delivered' ? 'taskDelivered' : 'taskAlreadyDelivered', { id }, language(io)));
  } else {
    // RELAYLEAD_ATTEMPT is set for each crew member: a replaced one cannot finish the new attempt.
    const attempt = io.env.RELAYLEAD_ATTEMPT;
    finishTask(mission, id, { state: action === 'done' ? 'done' : 'failed', summary: options.summary, attempt });
    await startTargetedPass(mission);
  }
  return 0;
};

commands.wait = async (args, io) => {
  const { options } = parseArgs(args);
  const timeout = options.timeout === undefined ? undefined : Number(options.timeout);
  if (timeout !== undefined && !(timeout >= 0)) {
    throw codedError('usage', { usage: 'relaylead wait [--timeout seconds] [--mission name]' });
  }
  const mission = missionName(options, io);
  refuseReplacedLead(mission, io);
  await waitForChanges(
    mission,
    timeout,
    (changes) => {
      io.out.write(JSON.stringify({ changes }, null, 2) + '\n');
    },
    { env: io.env },
  );
  return 0;
};

commands.question = async (args, io) => {
  const { positional, options, lists } = parseArgs(args);
  const [action, mission] = positional;
  if (action === 'ask') {
    const name = missionName(options, io);
    refuseReplacedLead(name, io);
    // The keys irr-… and perm-… belong to the hooks: only the user answers those questions.
    if (/^(irr|perm)[^a-z0-9]/i.test(String(options.key || ''))) {
      throw codedError('bad-question', { detail: 'the keys irr-… and perm-… are kept for Relaylead' });
    }
    const { id } = askQuestion(name, {
      key: options.key,
      text: options.text,
      context: options.context,
      options: lists.option,
      recommended: options.recommended === undefined ? undefined : Number(options.recommended),
    });
    io.out.write(id + '\n');
  } else if (action === 'list') {
    const name = mission || missionName(options, io);
    const questions = listQuestions(name, options.all ? {} : { state: 'open' });
    io.out.write(JSON.stringify(questions, null, 2) + '\n');
  } else {
    throw codedError('usage', {
      usage:
        'relaylead question ask --key k --text t [--context c] --option o --option o [--recommended n] | list [<mission>] [--all]',
    });
  }
  return 0;
};

commands.answer = async (args, io) => {
  refuseInSession('answer', io);
  const [mission, id, choice] = parseArgs(args).positional;
  if (!mission || !id || choice === undefined) {
    throw codedError('usage', { usage: 'relaylead answer <mission> <id> <choice>' });
  }
  const chosen = answerQuestion(mission, id, choice);
  await startTargetedPass(mission);
  io.out.write(t('questionAnswered', { id, choice: chosen }, language(io)));
  return 0;
};

// `relaylead watcher run`: one full pass over the missions, or with --mission a pass over that one
// alone, without the pass lock. Prints the lines the pass added to watcher.log. `start`, `stop` and
// `status` drive the loop; `loop` is the loop itself, started by `start` (internal, not in the help).
commands.watcher = async (args, io) => {
  refuseInSession('watcher', io);
  const { positional, options } = parseArgs(args);
  const [action] = positional;
  const known = ['run', 'start', 'stop', 'status', 'loop'].includes(action);
  if (positional.length !== 1 || !known || options.mission === '' || (action !== 'run' && options.mission !== undefined)) {
    throw codedError('usage', { usage: 'relaylead watcher run [--mission <name>] | start | stop | status' });
  }
  const lang = language(io);
  if (action === 'loop') {
    await loop();
    return 0;
  }
  if (action === 'start') {
    const outcome = await startWatcher();
    if (outcome === 'started') io.out.write(t('watcherStarted', { seconds: watcherSettings().everySeconds }, lang));
    else if (outcome === 'already') io.out.write(t('watcherAlreadyRunning', { since: watcherRunning().since }, lang));
    else io.out.write(t('watcherNothingToWatch', {}, lang));
    return 0;
  }
  if (action === 'stop') {
    const outcome = await stopWatcher();
    const key = { stopped: 'watcherStopped', requested: 'watcherStopRequested' }[outcome] || 'watcherNotRunning';
    io.out.write(t(key, {}, lang));
    return 0;
  }
  if (action === 'status') {
    const { running, since, lastPassAt } = watcherRunning();
    io.out.write(running ? t('watcherStatusRunning', { since, lastPass: lastPassAt || '-' }, lang) : t('watcherNotRunning', {}, lang));
    return 0;
  }
  const logSize = watchLogSize();
  if (options.mission) {
    readMission(options.mission); // mission-unknown
    if (stopPresent()) {
      io.out.write(t('watcherStopPresent', { home: home() }, lang));
      return 0;
    }
    // A targeted pass also starts a loop that is gone, never one the user stopped.
    if (watcherSettings().autoStart) {
      try {
        await startWatcher({ unlessStopped: true });
      } catch {
        // the pass goes on without the loop
      }
    }
    await tendMission(options.mission, { patient: true });
  } else {
    const result = await runPass();
    if (result.outcome === 'stop') {
      // STOP may have come during the pass: what it did before is printed too.
      io.out.write(watchLogSince(logSize) + t('watcherStopPresent', { home: home() }, lang));
      return 0;
    }
    if (result.outcome === 'busy') {
      io.out.write(t('watcherBusy', result.holder, lang));
      return 0;
    }
  }
  io.out.write(watchLogSince(logSize));
  return 0;
};

// Installation (lot 4): the only commands that write outside ~/.relaylead are install and uninstall.
commands.install = async (args, io) => {
  refuseInSession('install', io);
  install((key, vars) => io.out.write(t(key, vars, language(io))));
  return printDoctor(io);
};

commands.uninstall = async (args, io) => {
  refuseInSession('uninstall', io);
  const { options } = parseArgs(args);
  await uninstall((key, vars) => io.out.write(t(key, vars, language(io))), { purge: options.purge === true });
  return 0;
};

commands.doctor = async (args, io) => {
  refuseInSession('doctor', io);
  return printDoctor(io);
};

// One line per check: "ok|warn|fail <name>: <detail>". Exit 1 when a check failed.
async function printDoctor(io) {
  const lines = await doctor();
  for (const line of lines) io.out.write(`${line.level} ${line.name}: ${line.detail}\n`);
  return lines.some((line) => line.level === 'fail') ? 1 : 0;
}

commands.init = async (args, io) => {
  refuseInSession('init', io);
  await init(parseArgs(args).options, io, language(io));
  return 0;
};

// Internal, not in the help: started by `state set done`, it stops the lead once its turn is over.
// The createdAt of its mission (absent when started by an older relaylead) keeps it off a newer
// mission of the same name.
commands._reap = async (args) => {
  const [name, createdAt] = parseArgs(args).positional;
  try {
    await reapLead(name, createdAt);
  } finally {
    markReaperEnded(name, createdAt);
  }
  return 0;
};

async function run(argv, io) {
  io = io || { out: process.stdout, err: process.stderr, env: process.env, cwd: process.cwd() };
  const [first, ...args] = argv;

  if (first === '--version' || first === '-v') {
    io.out.write(pkg.version + '\n');
    return 0;
  }
  if (first === undefined || wantsHelp([first, ...args])) {
    io.out.write(t('help'));
    return 0;
  }
  if (!Object.prototype.hasOwnProperty.call(commands, first)) {
    io.err.write(t('unknownCommand', { command: first }) + t('help'));
    return 2;
  }
  try {
    return await commands[first](args, io);
  } catch (err) {
    // Expected errors (codedError) are printed in the user's language; others show their own text.
    // err.suffix says what became of a session the failure left behind (stopped, or still running).
    let text = err.message;
    if (err.vars) text = t(err.code, err.vars, language(io)) + (err.suffix ? t(err.suffix.key, err.suffix.vars, language(io)) : '');
    io.err.write(`relaylead ${first}: ${text}\n`);
    return 1;
  }
}

module.exports = { run, commands };
