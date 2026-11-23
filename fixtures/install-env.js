// What the installation tests share: a throwaway home, LaunchAgents folder and state for the fake
// launchctl and the fake claude, and a way to run the real CLI in its own process on them.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { tmpDir, userEnv } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'relaylead.js');

function installEnv(t, extra = {}) {
  const claudeState = tmpDir('relaylead-fake-claude-');
  // The PATH the plist freezes holds a `claude`, as on a real machine (doctor checks it). An empty
  // file, never run: RELAYLEAD_CLAUDE names the fake claude.
  const pathDir = tmpDir('relaylead-path-');
  fs.writeFileSync(path.join(pathDir, 'claude'), '');
  const base = userEnv();
  // On Windows the variable may be spelled Path: that spelling is kept.
  const pathKey = Object.keys(base).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
  const env = {
    ...base,
    [pathKey]: pathDir + path.delimiter + (base[pathKey] || ''),
    // init proposes the language from LANG: fixed, so a test does not depend on the machine's.
    LANG: 'en_US.UTF-8',
    RELAYLEAD_HOME: tmpDir('relaylead-home-'),
    RELAYLEAD_LAUNCHD_DIR: tmpDir('relaylead-agents-'),
    RELAYLEAD_LAUNCHCTL: path.join(__dirname, 'launchctl', 'fake-launchctl.js'),
    FAKE_LAUNCHCTL_STATE: tmpDir('relaylead-fake-launchctl-'),
    RELAYLEAD_CLAUDE: path.join(__dirname, 'claude', 'fake-claude.js'),
    FAKE_CLAUDE_STATE: claudeState,
    RELAYLEAD_PLATFORM: 'darwin',
    // Claude's own folder: never the real ~/.claude (uninstall --purge deletes the plugin cache there).
    CLAUDE_CONFIG_DIR: tmpDir('relaylead-claude-config-'),
    ...extra,
  };
  delete env.ANTHROPIC_API_KEY;
  // The sessions the fake claude started end with the test.
  t.after(() => fs.writeFileSync(path.join(claudeState, 'stop-all'), ''));
  return env;
}

// Runs `relaylead <args>` like a person in a terminal (no terminal: stdin is closed). No shell.
function runRelaylead(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

// What install changes outside the home: the LaunchAgents folder and the fake claude's plugins.
function outsideSnapshot(env) {
  const plugins = path.join(env.FAKE_CLAUDE_STATE, 'plugins.json');
  // Only what was added: the fake's sources and versions are its own bookkeeping.
  const { marketplaces, plugins: added } = fs.existsSync(plugins) ? JSON.parse(fs.readFileSync(plugins, 'utf8')) : { marketplaces: [], plugins: [] };
  return { agents: fs.readdirSync(env.RELAYLEAD_LAUNCHD_DIR), plugins: { marketplaces, plugins: added } };
}

module.exports = { installEnv, runRelaylead, outsideSnapshot };
