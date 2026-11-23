const fs = require('node:fs');
const path = require('node:path');
const { t, codedError } = require('./messages');
const { loadConfig, watcherSettings, setConfigValue } = require('./config');
const {
  createMission,
  setPriority,
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
const { waitForEvents } = require('./console-wait');
const { brief, eventsText } = require('./brief');
const { tellMission, listTold } = require('./told');
const { addDecision, readDecisions } = require('./decisions');
const { readMemory, writeMemory, memorySettings, requireCompaction } = require('./memory');
const { askQuestion, answerQuestion, listQuestions } = require('./questions');
const { mergeMission } = require('./merge');
const { runPass, tendMission, tendMergeOf, startQueuedTasks, stopPresent, loop, watcherRunning, startWatcher, stopWatcher } = require('./watcher');
const { watchLogSize, watchLogSince } = require('./watch-log');
const { home } = require('./paths');
const { readPause, localTime, refuseWhilePaused } = require('./usage-pause');
const detached = require('./detached');
const { install, uninstall } = require('./install');
const { doctor } = require('./doctor');
const { init } = require('./init');
const { buildOverview } = require('./overview');
const { queuedCount } = require('./places');
const { abandonment } = require('./abandon');
const { startDashboard } = require('./dashboard');
const { commandHelp } = require('./help');
const pkg = require('../package.json');

// Options that take no value.
const FLAGS = ['all', 'force', 'json', 'list', 'no-hooks', 'no-memory', 'no-open', 'purge', 'short', 'versioned-memory', 'yes'];

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

// Claude Code sets CLAUDE_CODE_ENTRYPOINT in the environment of its tools: "sdk-cli" under `claude -p`
// (observed, 2.1.330; the docs do not list this variable). Only that value: an app built on the Agent SDK
// ("sdk-ts", "sdk-py") may be a long conversation that does get the end of a background command.
const ONE_SHOT_MAX_WAIT = 60;
function isOneShotSession(env) {
  return env.CLAUDE_CODE_ENTRYPOINT === 'sdk-cli';
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
    tasks: options.tasks,
    force: options.force === true,
    onWarning: (warning) => io.err.write(`relaylead launch: ${t(warning.code, warning.vars, language(io))}\n`),
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
    // An unreadable mission shows its state folder, where the broken file is.
    const state = mission.unreadable ? mission.state : shownState(mission.name, mission.state, io);
    io.out.write(`${mission.name}  ${state}  ${lead}  ${mission.dir}\n`);
  }
  return 0;
};

// The state of a mission as the user sees it: that of its lead, or its pause for the usage limit,
// then its tasks waiting for a place, and whether it looks abandoned (core/abandon.js). Left alone once
// the mission is done or stopped.
function shownState(name, state, io) {
  if (/^(done|stopped)/.test(state)) return state;
  const lang = language(io);
  const pause = readPause(name);
  let shown = pause ? t('usagePausedState', { resumeAt: localTime(pause.resumeAt) }, lang) : state;
  const queued = queuedCount(name);
  if (queued > 0) shown += t('queuedMark', { n: queued }, lang);
  if (abandonment(name)) shown += t('abandonedMark', {}, lang);
  return shown;
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
  // A finished mission has no session left to open: the adapter's own error would say so badly.
  if (/^(done|stopped)/.test(state)) {
    io.out.write(t('showMissionOver', { mission: name, state }, language(io)));
    return 0;
  }
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

// The priority of a mission, changed while it runs: its usage thresholds and its rank in the queue.
// A targeted pass follows, so a queue that has a free place takes it at once.
commands.priority = async (args, io) => {
  refuseInSession('priority', io);
  const [name, priority] = parseArgs(args).positional;
  if (!name || !priority) throw codedError('usage', { usage: 'relaylead priority <mission> <high|normal|low>' });
  await setPriority(name, priority);
  io.out.write(t('prioritySet', { mission: name, priority }, language(io)));
  await startTargetedPass(name);
  return 0;
};

// `relaylead merge <mission>`: the user merges a done mission into the main branch of its project.
// On a conflict, a crew member resolves it and the watcher merges again: its loop is started then.
commands.merge = async (args, io) => {
  refuseInSession('merge', io);
  const [name] = parseArgs(args).positional;
  if (!name) throw codedError('usage', { usage: 'relaylead merge <mission>' });
  const lang = language(io);
  const result = await mergeMission(name);
  if (result.outcome === 'already') {
    io.out.write(t('mergeAlready', { mission: name, target: result.target }, lang));
  } else if (result.outcome === 'merged') {
    io.out.write(t('mergeDone', { mission: name, target: result.target, detail: result.url || result.sha }, lang));
  }
  if (result.outcome !== 'conflict') {
    // GitHub: the user's own branch is never pulled for them; they are told when it is behind.
    if (result.behind > 0) io.out.write(t('mergeBehind', { target: result.target, count: result.behind }, lang));
    if (result.notClosed && result.notClosed.length > 0) io.out.write(t('mergeIssuesOpen', { issues: result.notClosed.map((n) => '#' + n).join(', ') }, lang));
  } else {
    const files = result.conflicts.length > 0 ? result.conflicts.join(', ') : result.target;
    const queued = result.queued ? t('mergeQueued', {}, lang) : '';
    io.out.write(t('mergeConflict', { mission: name, target: result.target, files, task: result.task, queued }, lang));
    await startWatcherAfterLaunch(io);
  }
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
    throw codedError('usage', { usage: 'relaylead state get|set <state> [--note text] [--no-memory] [--mission name]' });
  }
  const mission = missionName(options, io);
  if (action === 'get') {
    io.out.write(getState(mission) + '\n');
  } else {
    refuseReplacedLead(mission, io);
    // The project memory is compacted before the mission is declared done, by a lead or by a person
    // (--no-memory: a way out when the memory cannot be written); a replayed `done` has been through this already.
    if (state === 'done' && !options['no-memory'] && getState(mission) !== 'done') requireCompaction(mission);
    const outcome = await setState(mission, state, options.note, { by: io.env.RELAYLEAD_SESSION || 'user' });
    io.out.write(t('missionStateSet', { mission, state }, language(io)));
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
        'relaylead task list [--short] | start <id> [--profile p] | retry <id> [--profile p] | deliver <id> [--no-hooks] | done <id> | fail <id> [--summary text] [--mission name]',
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
  if (action === 'list' && options.short) {
    // For the console: one line per task, which it reads at a glance.
    for (const task of listTasks(mission)) {
      const summary = task.summary ? ` — ${task.summary}` : '';
      io.out.write(`${task.id}  ${task.state}#${task.attempt}  ${task.title}${summary}\n`);
    }
  } else if (action === 'list') {
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
    throw codedError('usage', { usage: 'relaylead wait [--timeout seconds] [--mission name] | wait --all [--timeout seconds] [--json]' });
  }
  // The console's wait: every mission of the machine, events named by mission (core/console-wait.js),
  // as the short text of `brief` (--json: as JSON).
  if (options.all) {
    refuseInSession('wait --all', io);
    const lang = language(io);
    // A one-shot session (`claude -p`) never gets a turn back: a long wait would keep it from ending.
    if (isOneShotSession(io.env) && (timeout === undefined || timeout > ONE_SHOT_MAX_WAIT)) {
      io.out.write(t('waitOneShot', {}, lang));
      return 0;
    }
    await waitForEvents(timeout, (events) => io.out.write(options.json ? JSON.stringify({ events }, null, 2) + '\n' : eventsText(events, lang)));
    return 0;
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
    // The questions of a merge are asked by Relaylead itself (core/merge.js), not by this command.
    if (/^(done|stopped)/.test(getState(name))) throw codedError('mission-question-over', { mission: name });
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
    readMission(name); // mission-unknown, as for show
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
  const { positional, options } = parseArgs(args);
  const [mission, id, choice] = positional;
  // --other "<text>": a free answer in place of an option.
  if (!mission || !id || (choice === undefined) === (options.other === undefined)) {
    throw codedError('usage', { usage: 'relaylead answer <mission> <id> <choice> | relaylead answer <mission> <id> --other "<text>"' });
  }
  const chosen = answerQuestion(mission, id, choice, { other: options.other });
  await startTargetedPass(mission);
  io.out.write(t('questionAnswered', { id, choice: chosen }, language(io)));
  return 0;
};

// What the user tells a lead: kept in the mission, and the lead is woken like by an answer.
commands.tell = async (args, io) => {
  refuseInSession('tell', io);
  const [mission, ...words] = parseArgs(args).positional;
  if (!mission || words.length === 0) throw codedError('usage', { usage: 'relaylead tell <mission> <text>' });
  const id = tellMission(mission, words.join(' '));
  await startTargetedPass(mission);
  io.out.write(t('toldMessage', { id, mission }, language(io)));
  return 0;
};

// The lead notes a decision taken with the user in decisions.md of its mission.
commands.decision = async (args, io) => {
  const { positional, options } = parseArgs(args);
  if (positional.length === 0 && !options.list) throw codedError('usage', { usage: 'relaylead decision <text> | decision --list' });
  const mission = missionName(options, io);
  if (options.list) {
    // The messages of the user too: a successor of the lead that read them has no other way back to them.
    const told = listTold(mission).map((message) => `- ${message.at} ${message.text.replace(/\s+/g, ' ')}\n`);
    io.out.write(readDecisions(mission) + (told.length > 0 ? `\nMessages from the user:\n${told.join('')}` : ''));
    return 0;
  }
  refuseReplacedLead(mission, io);
  addDecision(mission, positional.join(' '));
  io.out.write(t('decisionNoted', {}, language(io)));
  return 0;
};

// The project memory of the mission's project: `memory show` reads it, `memory write` replaces it (the lead
// does both; the text comes from --file, or from --text where "\n" stands for a line break).
commands.memory = async (args, io) => {
  const { positional, options } = parseArgs(args);
  const [action] = positional;
  const usage = 'relaylead memory show | memory write --base <fingerprint> --file <file> | memory write --base <fingerprint> --text "<text>"';
  if (positional.length !== 1 || !['show', 'write'].includes(action)) throw codedError('usage', { usage });
  const mission = missionName(options, io);
  const lang = language(io);
  const dir = readMission(mission).dir;
  if (action === 'show') {
    if (!memorySettings(dir).enabled) io.out.write(t('memoryDisabled', {}, lang));
    else {
      const memory = readMemory(dir);
      io.out.write(t('memoryFingerprint', { fingerprint: memory.fingerprint }, lang));
      if (memory.text === '') io.out.write(t('memoryEmpty', {}, lang));
      else {
        if (memory.tooBig) io.out.write(t('memoryTooBig', { bytes: memory.bytes, max: memory.maxBytes }, lang));
        else if (memory.tooLong) io.out.write(t('memoryTooLong', { lines: memory.lines, max: memory.maxLines }, lang));
        io.out.write(memory.shown);
        if (memory.hidden > 0) io.out.write(t('memoryTruncated', { hidden: memory.hidden }, lang));
      }
    }
    return 0;
  }
  if ((options.file === undefined) === (options.text === undefined) || !options.base) throw codedError('usage', { usage });
  refuseReplacedLead(mission, io);
  let text = options.text === undefined ? '' : options.text.replace(/\\n/g, '\n');
  if (options.file !== undefined) {
    try {
      text = fs.readFileSync(path.resolve(io.cwd, options.file), 'utf8');
    } catch (err) {
      throw codedError('memory-file-unreadable', { file: options.file, detail: err.message });
    }
  }
  const lines = await writeMemory(mission, text, options.base);
  io.out.write(t('memoryWritten', { lines }, lang));
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
    await tendMergeOf(options.mission);
    await startQueuedTasks();
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
  // The language is read before --purge deletes the configuration that holds it.
  const lang = language(io);
  await uninstall((key, vars) => io.out.write(t(key, vars, lang)), { purge: options.purge === true, force: options.force === true });
  return 0;
};

commands.doctor = async (args, io) => {
  refuseInSession('doctor', io);
  return printDoctor(io);
};

// One line per check: "ok|warn|fail <name>: <detail>". Exit 1 when a check failed.
async function printDoctor(io) {
  const lines = await doctor(io.cwd, language(io));
  for (const line of lines) io.out.write(`${line.level} ${line.name}: ${line.detail}\n`);
  return lines.some((line) => line.level === 'fail') ? 1 : 0;
}

// `relaylead brief`: what the console shows when a conversation opens (core/brief.js).
commands.brief = async (args, io) => {
  refuseInSession('brief', io);
  await brief(io.cwd, language(io), (text) => io.out.write(text));
  return 0;
};

commands.init = async (args, io) => {
  refuseInSession('init', io);
  await init(parseArgs(args).options, io, language(io));
  return 0;
};

// The one view the displays share (core/overview.js), as JSON.
commands.overview = async (args, io) => {
  if (!parseArgs(args).options.json) throw codedError('usage', { usage: 'relaylead overview --json' });
  io.out.write(JSON.stringify(buildOverview(), null, 2) + '\n');
  return 0;
};

commands.config = async (args, io) => {
  refuseInSession('config', io);
  const [action, key, value] = parseArgs(args).positional;
  if (action !== 'set' || !key || value === undefined) throw codedError('usage', { usage: 'relaylead config set <key> <value>' });
  io.out.write(t('configSet', { key, value: setConfigValue(key, value) }, language(io)));
  return 0;
};

// Runs a command of the CLI for the dashboard and gives back {ok, message}, in the user's language.
async function runForDashboard(args, io) {
  const out = { text: '', write(chunk) { this.text += chunk; } };
  const err = { text: '', write(chunk) { this.text += chunk; } };
  const code = await run(args, { out, err, env: {}, cwd: io.cwd });
  return { ok: code === 0, message: (code === 0 ? out.text : err.text).trim() };
}

// `relaylead dashboard`: serves the page until Ctrl-C. --no-open does not open the browser; --port
// overrides display.dashboardPort for this launch.
commands.dashboard = async (args, io) => {
  refuseInSession('dashboard', io);
  const { options } = parseArgs(args);
  const port = options.port === undefined ? loadConfig().display.dashboardPort : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw codedError('usage', { usage: 'relaylead dashboard [--port n] [--no-open]' });
  const { server, url } = await startDashboard({
    port,
    actions: {
      answer: (mission, id, choice) => runForDashboard(['answer', mission, id, String(choice)], io),
      answerOther: (mission, id, text) => runForDashboard(['answer', mission, id, '--other', String(text)], io),
      stop: (mission) => runForDashboard(['stop', mission], io),
    },
  });
  io.out.write(t('dashboardRunning', { url }, language(io)));
  if (!options['no-open']) openInBrowser(url);
  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    server.once('close', resolve);
  });
  server.close();
  return 0;
};

// The browser is opened by macOS `open`; a failure is not an error (the url is printed).
function openInBrowser(url) {
  try {
    const child = require('node:child_process').spawn('open', [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // the url is on screen
  }
}

// `relaylead help [command]`: the list of commands, or the help of one.
commands.help = async (args, io) => {
  const lang = language(io);
  const [name] = parseArgs(args).positional;
  if (name === undefined) {
    io.out.write(t('help', {}, lang));
    return 0;
  }
  const text = commandHelp(name, lang);
  if (!text) {
    io.err.write(t('unknownCommand', { command: name }, lang) + t('help', {}, lang));
    return 2;
  }
  io.out.write(text);
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
  const known = Object.prototype.hasOwnProperty.call(commands, first || '');
  // `relaylead <command> --help`: the help of that command; anywhere else, the general help.
  if (known && wantsHelp(args)) {
    io.out.write(commandHelp(first, language(io)) || t('help', {}, language(io)));
    return 0;
  }
  if (first === undefined || wantsHelp([first, ...args])) {
    io.out.write(t('help', {}, language(io)));
    return 0;
  }
  if (!known) {
    io.err.write(t('unknownCommand', { command: first }, language(io)) + t('help', {}, language(io)));
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
