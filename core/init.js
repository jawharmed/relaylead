// `relaylead init`: sets up the machine (once), then the current project. Questions only in a terminal;
// with --yes, or without a terminal, the defaults are taken and nothing is asked.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const tty = require('node:tty');
const { home } = require('./paths');
const { readJson, writeJson } = require('./store');
const { DEFAULTS, deepMerge } = require('./config');
const { importApiKey } = require('./auth');
const { checkVersion } = require('../adapters/claude');
const { runFileSync } = require('./run-file');
const { codedError, t } = require('./messages');
const { install } = require('./install');
const { updateExclude } = require('./memory');

const MIN_NODE = 18;

// ask(question, default) -> the answer; the default when nothing is asked or the line is empty.
function makeAsker(options, io) {
  // process.stdin is only touched in a terminal: reading it keeps the process alive.
  const terminal = io.stdin ? io.stdin.isTTY : tty.isatty(0);
  if (options.yes || !terminal) return { interactive: false, ask: async (question, fallback) => fallback, close() {} };
  const rl = readline.createInterface({ input: io.stdin || process.stdin, output: io.out });
  return {
    interactive: true,
    ask: (question, fallback) =>
      new Promise((resolve) => rl.question(`${question} [${fallback}] `, (answer) => resolve(answer.trim() || fallback))),
    close: () => rl.close(),
  };
}

// The language of the machine: fr when LANG starts with fr, en otherwise, unless the user says another.
async function chooseLanguage(asker, env) {
  const fallback = /^fr/i.test(env.LANG || '') ? 'fr' : 'en';
  const answer = await asker.ask(t('init-ask-language', {}, fallback), fallback);
  return answer.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

// The authentication chosen: { auth } to merge into the configuration, or null to leave it as it is.
// `ask(key)` is a question in the user's language.
async function chooseAuth(options, asker, env, say, ask) {
  if (options['api-key-env']) {
    const file = importApiKey(options['api-key-env'], env, path.join(home(), 'api-key'));
    say('api-key-stored', { file });
    return { mode: 'api-key', keyFile: null };
  }
  if (options['api-key-file']) {
    return { mode: 'api-key', keyFile: path.resolve(options['api-key-file']) };
  }
  const mode = await asker.ask(ask('init-ask-auth'), 'login');
  if (mode !== 'api-key') return { mode: 'login', keyFile: null };
  const name = await asker.ask(ask('init-ask-env'), 'ANTHROPIC_API_KEY');
  const file = importApiKey(name, env, path.join(home(), 'api-key'));
  say('api-key-stored', { file });
  return { mode: 'api-key', keyFile: null };
}

// Returns true when the user said yes to running install. `current.lang` is the language of what is
// said from now on: the one just chosen, written to the configuration when it has none.
async function setUpMachine(options, asker, io, say, current) {
  const file = path.join(home(), 'config.json');
  const existing = readJson(file, null);
  const authGiven = options['api-key-env'] || options['api-key-file'];
  const ask = (key) => t(key, {}, current.lang);
  let language = null;
  if (!existing || !existing.language) {
    language = await chooseLanguage(asker, io.env);
    current.lang = language;
  }
  if (existing && !authGiven) {
    if (language) {
      writeJson(file, { ...existing, language });
      say('init-machine-written', { file });
    } else {
      say('init-machine-kept', { file });
    }
    return false;
  }
  if (!existing) {
    if (Number(process.versions.node.split('.')[0]) < MIN_NODE) throw codedError('node-too-old', { min: MIN_NODE, found: process.versions.node });
    try {
      await checkVersion();
    } catch (err) {
      if (err.code === 'claude-not-found') throw codedError('agent-missing', { agent: 'claude' });
      throw err;
    }
  }
  const auth = await chooseAuth(options, asker, io.env, say, ask);
  const wanted = { agent: DEFAULTS.agent, permissionMode: DEFAULTS.permissionMode };
  // What is already in the file wins, except the authentication the user has just chosen.
  const merged = deepMerge(deepMerge(wanted, existing || {}), { auth });
  if (language) merged.language = language;
  if (!existing || JSON.stringify(merged) !== JSON.stringify(existing)) writeJson(file, merged);
  say('init-machine-written', { file });
  if (auth.mode === 'api-key') say('api-key-helper-hint', {});
  if (!existing && asker.interactive) return isYes(await asker.ask(ask('init-ask-install'), ask('init-no')));
  return false;
}

// yes / no answers: anything that starts with y (or o, for "oui") is a yes.
const isYes = (answer) => /^(y|o)/i.test(answer);

async function setUpProject(dir, options, asker, say, current) {
  const ask = (key) => t(key, {}, current.lang);
  try {
    const top = runFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (fs.realpathSync.native(top) !== fs.realpathSync.native(dir)) throw new Error('not the root');
  } catch {
    throw codedError('not-a-git-repo', { dir });
  }
  const file = path.join(dir, '.relaylead.json');
  if (fs.existsSync(file)) {
    say('init-project-kept', { file });
  } else {
    const enabled = options['no-memory'] ? false : isYes(await asker.ask(ask('init-ask-memory'), ask('init-yes')));
    // Versioned: committed with the code. Otherwise it stays out of git (.git/info/exclude).
    const versioned = enabled && (options['versioned-memory'] || isYes(await asker.ask(ask('init-ask-versioned'), ask('init-no'))));
    writeJson(file, { team: 'code', method: DEFAULTS.method, source: DEFAULTS.source, delivery: DEFAULTS.delivery, memory: { enabled, versioned } });
    say('init-project-written', { file });
    if (enabled) updateExclude(dir, versioned);
  }
  say('init-trust-hint', { dir });
  say('init-advice', {});
}

async function init(options, io, lang) {
  const current = { lang };
  const say = (key, vars) => io.out.write(t(key, vars, current.lang));
  const asker = makeAsker(options, io);
  try {
    const wantsInstall = await setUpMachine(options, asker, io, say, current);
    await setUpProject(io.cwd, options, asker, say, current);
    if (wantsInstall) install(say);
    else if (!fs.existsSync(path.join(home(), 'install.json'))) say('init-next', {});
  } finally {
    asker.close();
  }
}

module.exports = { init };
