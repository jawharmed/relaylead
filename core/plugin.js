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

function installPlugin() {
  claudePlugin(['marketplace', 'add', PLUGIN_DIR]);
  claudePlugin(['install', PLUGIN_ID]);
}

function uninstallPlugin() {
  claudePlugin(['uninstall', PLUGIN_ID]);
  claudePlugin(['marketplace', 'remove', MARKETPLACE]);
}

// Whether the plugin is installed. Throws when `claude plugin list` fails.
function pluginInstalled() {
  const list = JSON.parse(claudePlugin(['list', '--json']));
  return list.some((plugin) => plugin.id === PLUGIN_ID);
}

module.exports = { PLUGIN_DIR, MARKETPLACE, PLUGIN_ID, installPlugin, uninstallPlugin, pluginInstalled };
