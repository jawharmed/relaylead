// The scheduler: a launchd agent that runs `relaylead watcher run` every few minutes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { home } = require('./paths');
const { writeText } = require('./store');
const { watcherSettings } = require('./config');
const { assertSupported } = require('./platform');
const { codedError } = require('./messages');
const { sleepSync } = require('./timing');

const LABEL = 'dev.relaylead.watcher';
const PACKAGE_DIR = path.join(__dirname, '..');

function launchAgentsDir() {
  return process.env.RELAYLEAD_LAUNCHD_DIR || path.join(os.homedir(), 'Library', 'LaunchAgents');
}

function plistPath() {
  return path.join(launchAgentsDir(), `${LABEL}.plist`);
}

function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The text of the plist. `home` is the folder of the log; `relayleadHome` is only set when the user
// chose another RELAYLEAD_HOME. No API key goes here: the watcher reads it from its own file.
function buildPlist({ node, bin, home: logDir, path: searchPath, relayleadHome, everySeconds }) {
  const strings = (values) => values.map((value) => `    <string>${escapeXml(value)}</string>`).join('\n');
  const log = path.join(logDir, 'launchd.log');
  const environment = [`    <key>PATH</key>\n    <string>${escapeXml(searchPath || '')}</string>`];
  if (relayleadHome) environment.push(`    <key>RELAYLEAD_HOME</key>\n    <string>${escapeXml(relayleadHome)}</string>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    strings([node, bin, 'watcher', 'run']),
    '  </array>',
    '  <key>StartInterval</key>',
    `  <integer>${everySeconds}</integer>`,
    '  <key>RunAtLoad</key>',
    '  <false/>',
    '  <key>StandardOutPath</key>',
    `  <string>${escapeXml(log)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapeXml(log)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    environment.join('\n'),
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

// The program to run: RELAYLEAD_LAUNCHCTL (a .js file runs with node), or launchctl.
function launchctlCommand() {
  const chosen = process.env.RELAYLEAD_LAUNCHCTL;
  if (chosen && chosen.endsWith('.js')) return { file: process.execPath, prefix: [chosen] };
  return { file: chosen || 'launchctl', prefix: [] };
}

// Runs launchctl with an array of arguments, never through a shell. Throws when it fails.
function launchctl(args) {
  const { file, prefix } = launchctlCommand();
  return execFileSync(file, [...prefix, ...args], { stdio: 'pipe', encoding: 'utf8' });
}

function domain() {
  return `gui/${process.getuid ? process.getuid() : 0}`;
}

function failure(step, err) {
  const detail = String((err.stderr || '') + (err.message || '')).trim();
  return codedError('scheduler-failed', { step, detail });
}

function installScheduler() {
  assertSupported();
  const file = plistPath();
  const text = buildPlist({
    node: process.execPath,
    bin: path.join(PACKAGE_DIR, 'bin', 'relaylead.js'),
    home: home(),
    path: process.env.PATH,
    relayleadHome: process.env.RELAYLEAD_HOME,
    everySeconds: watcherSettings().everySeconds,
  });
  try {
    writeText(file, text);
  } catch (err) {
    throw failure('write', err);
  }
  try {
    launchctl(['bootout', `${domain()}/${LABEL}`]);
  } catch {
    // not loaded yet: nothing to remove
  }
  waitUntilUnloaded();
  bootstrap(file);
  return file;
}

// bootout may return before the service is gone, and a bootstrap right after then fails with
// error 5: wait until `print` fails (every 100 ms, 3 s at most).
function waitUntilUnloaded() {
  for (let waited = 0; waited < 3000; waited += 100) {
    try {
      launchctl(['print', `${domain()}/${LABEL}`]);
    } catch {
      return;
    }
    sleepSync(100);
  }
}

// Tries bootstrap up to three times, 500 ms apart, before giving up.
function bootstrap(file) {
  for (let attempt = 1; ; attempt++) {
    try {
      launchctl(['bootstrap', domain(), file]);
      return;
    } catch (err) {
      if (attempt === 3) throw failure('bootstrap', err);
      sleepSync(500);
    }
  }
}

// Does nothing when no plist is there.
function uninstallScheduler() {
  assertSupported();
  const file = plistPath();
  if (!fs.existsSync(file)) return false;
  try {
    launchctl(['bootout', `${domain()}/${LABEL}`]);
  } catch {
    // not loaded: the file can go all the same
  }
  fs.rmSync(file, { force: true });
  return true;
}

// What the plist froze at install: {node, bin, path}, read back from its text; null without a plist
// or when it is not one of ours.
function readPlist() {
  let text;
  try {
    text = fs.readFileSync(plistPath(), 'utf8');
  } catch {
    return null;
  }
  const unescape = (value) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const program = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
  if (!program) return null;
  const [node, bin] = [...program[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => unescape(match[1]));
  const searchPath = /<key>PATH<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(text);
  return { node: node || null, bin: bin || null, path: searchPath ? unescape(searchPath[1]) : '' };
}

function schedulerStatus() {
  const installed = fs.existsSync(plistPath());
  let loaded = false;
  try {
    launchctl(['print', `${domain()}/${LABEL}`]);
    loaded = true;
  } catch {
    // not loaded
  }
  return { installed, loaded };
}

module.exports = { LABEL, plistPath, buildPlist, readPlist, installScheduler, uninstallScheduler, schedulerStatus };
