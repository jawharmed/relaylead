const path = require('node:path');
const { t, codedError } = require('./messages');
const { loadConfig } = require('./config');
const { createMission, listMissions, stopMission, getState, setState } = require('./missions');
const pkg = require('../package.json');

// A sub-command not delivered yet.
function notImplemented(name) {
  return async (args, io) => {
    io.err.write(t('notImplemented', { command: name }));
    return 1;
  };
}

// Splits arguments into positional values and `--name value` options.
function parseArgs(args) {
  const positional = [];
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      options[args[i].slice(2)] = args[i + 1];
      i++;
    } else {
      positional.push(args[i]);
    }
  }
  return { positional, options };
}

function language(io) {
  try {
    return loadConfig({ dir: io.cwd }).language;
  } catch {
    return 'en';
  }
}

// Each sub-command is (args, io) -> Promise<exit code>. Later tasks replace the placeholders.
const commands = {};
for (const name of ['launch', 'list', 'show', 'stop', 'task', 'state', 'wait', 'question', 'answer']) {
  commands[name] = notImplemented(name);
}

commands.launch = async (args, io) => {
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
  return 0;
};

commands.list = async (args, io) => {
  const missions = listMissions();
  if (missions.length === 0) io.out.write(t('noMissions', {}, language(io)));
  for (const mission of missions) {
    const lead = mission.lead ? mission.lead.sessionName : '-';
    io.out.write(`${mission.name}  ${mission.state}  ${lead}  ${mission.dir}\n`);
  }
  return 0;
};

commands.stop = async (args, io) => {
  const [name] = parseArgs(args).positional;
  if (!name) throw codedError('usage', { usage: 'relaylead stop <mission>' });
  await stopMission(name);
  io.out.write(t('missionStopped', { mission: name }, language(io)));
  return 0;
};

commands.state = async (args, io) => {
  const { positional, options } = parseArgs(args);
  const [action, state] = positional;
  if (action !== 'get' && !(action === 'set' && state)) {
    throw codedError('usage', { usage: 'relaylead state get|set <state> [--note text] [--mission name]' });
  }
  const mission = options.mission || io.env.RELAYLEAD_MISSION;
  if (!mission) throw codedError('no-mission', {});
  if (action === 'get') {
    io.out.write(getState(mission) + '\n');
  } else {
    setState(mission, state, options.note);
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
  if (first === undefined || first === '--help' || first === '-h') {
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
    const text = err.vars ? t(err.code, err.vars, language(io)) : err.message;
    io.err.write(`relaylead ${first}: ${text}\n`);
    return 1;
  }
}

module.exports = { run, commands };
