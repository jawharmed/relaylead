const fs = require('node:fs');
const path = require('node:path');
const { home } = require('./paths');
const { readJson } = require('./store');

const DEFAULTS = {
  language: 'en',
  agent: 'claude',
  method: 'code',
  permissionMode: 'allowlist',
  parallel: 4,
  maxAttempts: 2,
  priority: 'normal',
  questions: { onTimeout: 'wait' },
  source: { type: 'tasks-dir', dir: 'tasks' },
  delivery: { type: 'local-merge', branch: 'relaylead/integration' },
  guard: {
    protectedBranches: ['main', 'master'],
    secrets: ['.env', '.env.*'],
    secretExceptions: ['.env.example', '.env.sample', '.env.template'],
    allow: [],
  },
  attribution: null,
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

module.exports = { DEFAULTS, loadConfig, resolveSecret };
