const fs = require('node:fs');
const path = require('node:path');
const { home } = require('./paths');
const { readJson, writeJson } = require('./store');
const { codedError } = require('./messages');

const DEFAULTS = {
  language: 'en',
  agent: 'claude',
  method: 'code',
  permissionMode: 'allowlist',
  parallel: 4,
  maxAttempts: 2,
  priority: 'normal',
  // A question open for timeoutMinutes: 'wait' only reminds the user, 'recommended' applies its
  // recommended option, 'skip' its "Skip this task" option (core/watcher-rules.js, rule 30).
  questions: { onTimeout: 'wait', timeoutMinutes: 60 },
  source: { type: 'tasks-dir', dir: 'tasks' },
  delivery: { type: 'local-merge', branch: 'relaylead/integration', runHooks: true },
  guard: {
    protectedBranches: ['main', 'master'],
    secrets: ['.env', '.env.*'],
    secretExceptions: ['.env.example', '.env.sample', '.env.template'],
    allow: [],
  },
  attribution: null,
  // Thresholds of a session's context: soft = its first reading + the budget of its role, capped at
  // capPercent of its window when the window is measured; hard = soft + hardPercent (core/readings.js).
  context: { budgets: { lead: 150000, crew: 250000 }, capPercent: 40, hardPercent: 20 },
  // The watcher (core/watcher.js), read from the machine file alone: autoStart, its loop started by
  // `relaylead launch`; helpers, its targeted passes; everySeconds, the time between two passes of the loop.
  watcher: { autoStart: true, helpers: true, everySeconds: 300 },
  // How claude signs in: `login` (the Claude account already connected) or `api-key` (the key is in
  // keyFile, `<home>/api-key` when null; core/auth.js).
  auth: { mode: 'login', keyFile: null },
  // The usage limits of the account (core/usage.js): a mission pauses once the 5-hour or the 7-day
  // usage reaches the threshold of its priority, in percent; after a usage limit hit without a time
  // to resume at, it tries again after these minutes, then the next ones, then the last one again.
  // What the user sees of the missions (core/overview.js): pane is 'always', 'never' or null (asked on the
  // first mission); statusLine turns off the Claude Code status line entry; dashboardPort is the port of
  // `relaylead dashboard`.
  // The project memory (core/memory.js): enabled, its ceiling in lines, and versioned (kept with the code;
  // otherwise it is excluded from git through .git/info/exclude).
  memory: { enabled: true, maxLines: 200, versioned: false },
  display: { pane: null, statusLine: true, dashboardPort: 4317 },
  usage: {
    thresholds: { low: { week: 70, fiveHour: 80 }, normal: { week: 90, fiveHour: 85 }, high: { week: 98, fiveHour: 85 } },
    retryMinutes: [15, 30, 60],
  },
};

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Plain objects are merged key by key; arrays and scalars are replaced.
function deepMerge(base, extra) {
  const result = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    result[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return result;
}

// DEFAULTS < machine file < project file < params
function loadConfig({ dir, params } = {}) {
  const machine = readJson(path.join(home(), 'config.json'), {});
  const project = dir ? readJson(path.join(dir, '.relaylead.json'), {}) : {};
  return deepMerge(deepMerge(deepMerge(structuredClone(DEFAULTS), machine), project), params || {});
}

// The watcher's settings, read from the machine file at each call. RELAYLEAD_WATCHER=off (set for the
// whole test suite) turns off both the loop started by launch and the targeted passes. everySeconds is
// a whole number of at least 1, otherwise 300.
function watcherSettings() {
  const { watcher } = loadConfig();
  const off = process.env.RELAYLEAD_WATCHER === 'off';
  const every = watcher.everySeconds;
  return {
    autoStart: !off && watcher.autoStart !== false,
    helpers: !off && watcher.helpers !== false,
    everySeconds: Number.isInteger(every) && every >= 1 ? every : DEFAULTS.watcher.everySeconds,
  };
}

// The settings `relaylead config set` may write, each with the check of its value (returns the value
// to store, or undefined when it is not valid). Only display settings: the rest is edited by hand.
const SETTABLE = {
  'display.pane': (text) => (['always', 'never'].includes(text) ? text : undefined),
  'display.statusLine': (text) => ({ true: true, false: false })[text],
  'display.dashboardPort': (text) => (/^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= 65535 ? Number(text) : undefined),
};

// Writes one setting in the machine file (~/.relaylead/config.json), the other settings kept.
function setConfigValue(key, text) {
  const check = SETTABLE[key];
  if (!check) throw codedError('config-unknown-key', { key, keys: Object.keys(SETTABLE).join(', ') });
  const value = check(text);
  if (value === undefined) throw codedError('config-bad-value', { key, value: text });
  const file = path.join(home(), 'config.json');
  const machine = readJson(file, {});
  const [section, name] = key.split('.');
  writeJson(file, { ...machine, [section]: { ...machine[section], [name]: value } });
  return value;
}

// Secrets are never stored in config: only "env:NAME" or "file:path" references.
function resolveSecret(ref) {
  if (typeof ref === 'string' && ref.startsWith('env:')) {
    const value = process.env[ref.slice(4)];
    if (value === undefined) throw new Error(`environment variable not set: ${ref.slice(4)}`);
    return value;
  }
  if (typeof ref === 'string' && ref.startsWith('file:')) {
    return fs.readFileSync(ref.slice(5), 'utf8').trim();
  }
  throw new Error('secrets must be references: use env:NAME or file:path');
}

module.exports = { DEFAULTS, deepMerge, loadConfig, watcherSettings, setConfigValue, resolveSecret };
