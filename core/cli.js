const { t } = require('./messages');
const pkg = require('../package.json');

// A sub-command not delivered yet.
function notImplemented(name) {
  return async (args, io) => {
    io.err.write(t('notImplemented', { command: name }));
    return 1;
  };
}

// Each sub-command is (args, io) -> Promise<exit code>. Later tasks replace the placeholders.
const commands = {};
for (const name of ['launch', 'list', 'show', 'stop', 'task', 'state', 'wait', 'question', 'answer']) {
  commands[name] = notImplemented(name);
}

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
  return commands[first](args, io);
}

module.exports = { run, commands };
