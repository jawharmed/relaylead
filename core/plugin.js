// The Claude Code plugin (plugin/): slash commands /relaylead:*. Installed and removed only through
// `claude plugin ...`; nothing is written in ~/.claude directly (but see removePluginCache).
const fs = require('node:fs');
const os = require('node:os');
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

// The marketplace as `claude plugin marketplace list` shows it, or undefined.
function findMarketplace() {
  return JSON.parse(claudePlugin(['marketplace', 'list', '--json'])).find((market) => market.name === MARKETPLACE);
}

function marketplaceKnown() {
  return Boolean(findMarketplace());
}

// The plugin as `claude plugin list` shows it ({ id, version, ... }), or undefined. Throws when it fails.
function findPlugin() {
  return JSON.parse(claudePlugin(['list', '--json'])).find((plugin) => plugin.id === PLUGIN_ID);
}

function pluginInstalled() {
  return Boolean(findPlugin());
}

// The version this package ships, from its plugin.json.
function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, '.claude-plugin', 'plugin.json'), 'utf8')).version;
}

// A directory marketplace that points at another folder than this package's (the package moved, for
// instance a new global install): Claude Code would go on reading the old folder.
function marketplaceMoved(market) {
  return market.source === 'directory' && typeof market.path === 'string' && path.resolve(market.path) !== path.resolve(PLUGIN_DIR);
}

// Each step is skipped when already done, and reported to `done(step)` once it has worked, so a failure
// halfway leaves a record of what was added. A plugin already installed in another version than the
// package's (or from a marketplace that moved) is updated with `claude plugin update`, never removed.
// Returns { updated, from, to }: `updated` is true when an older plugin was brought up to date.
function installPlugin(done) {
  let market = findMarketplace();
  if (market && marketplaceMoved(market)) {
    // The source of a marketplace cannot be changed: it is added again, from this package's folder.
    claudePlugin(['marketplace', 'remove', MARKETPLACE]);
    market = undefined;
  }
  if (!market) claudePlugin(['marketplace', 'add', PLUGIN_DIR]);
  done('marketplace');
  const installed = findPlugin();
  const to = packageVersion();
  let updated = false;
  if (!installed) claudePlugin(['install', PLUGIN_ID]);
  else if (installed.version !== to) {
    claudePlugin(['marketplace', 'update', MARKETPLACE]);
    claudePlugin(['update', PLUGIN_ID]);
    updated = true;
  }
  done('plugin');
  return { updated, from: installed && installed.version, to };
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

// What Claude Code leaves of the plugin after `claude plugin uninstall`: its folder in the cache
// (marked orphaned, not removed). The one place under ~/.claude that Relaylead deletes, and only
// this exact folder, with `uninstall --purge`.
function removePluginCache() {
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  fs.rmSync(path.join(claudeHome, 'plugins', 'cache', MARKETPLACE), { recursive: true, force: true });
}

module.exports = { removePluginCache, PLUGIN_DIR, MARKETPLACE, PLUGIN_ID, installPlugin, uninstallPlugin, pluginInstalled, marketplaceKnown };
