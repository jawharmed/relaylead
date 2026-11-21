// The Claude Code plugin (plugin/): slash commands /relaylead:*. Installed and removed only through
// `claude plugin ...`; nothing is written in ~/.claude directly.
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { claudeCommand } = require('../adapters/claude');
const { codedError } = require('./messages');

const PLUGIN_DIR = path.join(__dirname, '..', 'plugin');
const MARKETPLACE = 'relaylead-local';
const PLUGIN_ID = `relaylead@${MARKETPLACE}`;
const TIMEOUT_MS = 60 * 1000;

// Runs `claude plugin <args>` and returns its stdout. No shell.
function claudePlugin(args) {
  const { file, prefix } = claudeCommand();
  try {
    return execFileSync(file, [...prefix, 'plugin', ...args], { stdio: 'pipe', encoding: 'utf8', timeout: TIMEOUT_MS });
  } catch (err) {
    if (err.code === 'ENOENT') throw codedError('claude-not-found', {});
    const detail = String((err.stderr || '') + (err.stdout || '') || err.message).trim();
    throw codedError('claude-failed', { command: `claude plugin ${args.join(' ')}`, output: detail });
  }
}

function marketplaceKnown() {
  return JSON.parse(claudePlugin(['marketplace', 'list', '--json'])).some((market) => market.name === MARKETPLACE);
}

// Whether the plugin is installed. Throws when `claude plugin list` fails.
function pluginInstalled() {
  return JSON.parse(claudePlugin(['list', '--json'])).some((plugin) => plugin.id === PLUGIN_ID);
}

// Each step is skipped when already done, and reported to `done(step)` once it has worked, so a failure
// halfway leaves a record of what was added.
function installPlugin(done) {
  if (!marketplaceKnown()) claudePlugin(['marketplace', 'add', PLUGIN_DIR]);
  done('marketplace');
  if (!pluginInstalled()) claudePlugin(['install', PLUGIN_ID]);
  done('plugin');
}

// Each step on its own: one that fails does not stop the other. Returns the failures
// [{ step, command, detail }]; something already gone counts as done.
function uninstallPlugin() {
  const failures = [];
  const attempt = (step, isThere, args) => {
    try {
      if (isThere()) claudePlugin(args);
    } catch (err) {
      failures.push({ step, command: `claude plugin ${args.join(' ')}`, detail: err.message });
    }
  };
  attempt('plugin', pluginInstalled, ['uninstall', PLUGIN_ID]);
  attempt('marketplace', marketplaceKnown, ['marketplace', 'remove', MARKETPLACE]);
  return failures;
}

module.exports = { PLUGIN_DIR, MARKETPLACE, PLUGIN_ID, installPlugin, uninstallPlugin, pluginInstalled, marketplaceKnown };
