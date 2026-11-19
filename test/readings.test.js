const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { shortIdOf, contextFromTranscript, contextOf } = require('../core/readings');
const { DEFAULTS } = require('../core/config');
const { tmpDir } = require('../fixtures/helpers');

const TRANSCRIPT = path.join(__dirname, '..', 'fixtures', 'claude', 'transcript.jsonl');
const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const config = structuredClone(DEFAULTS);

// A reading taken `minutes` before NOW.
function reading(minutes, fields) {
  return { at: new Date(NOW - minutes * 60 * 1000).toISOString(), ...fields };
}

function answerLine(tokens) {
  return JSON.stringify({ type: 'assistant', isSidechain: false, message: { usage: { input_tokens: tokens } } }) + '\n';
}

// `size` bytes of user lines, one JSON line each.
function userLines(size) {
  const line = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(1000) } }) + '\n';
  return line.repeat(Math.ceil(size / line.length));
}

test('a session id gives its short id only when it starts with eight hex digits', () => {
  assert.strictEqual(shortIdOf('e5f3afe7-14cd-46fa-8c10-9276bd720a82'), 'e5f3afe7');
  for (const id of ['E5F3AFE7-14cd', 'e5f3afe', 'fake-e5f3afe7', '', null, undefined, 42]) {
    assert.strictEqual(shortIdOf(id), null, String(id));
  }
});

test('the context of a transcript is the input of its last main-thread answer', () => {
  assert.strictEqual(contextFromTranscript(TRANSCRIPT), 42366);
});

test('a transcript is read from its last 256 KiB only', () => {
  const dir = tmpDir();
  const recent = path.join(dir, 'recent.jsonl');
  fs.writeFileSync(recent, userLines(2 * 1024 * 1024) + answerLine(50000));
  assert.strictEqual(contextFromTranscript(recent), 50000);

  const old = path.join(dir, 'old.jsonl');
  fs.writeFileSync(old, answerLine(50000) + userLines(1024 * 1024) + userLines(1024 * 1024));
  assert.strictEqual(contextFromTranscript(old), null);
});

test('a missing or unreadable transcript gives no context', () => {
  const dir = tmpDir();
  const empty = path.join(dir, 'empty.jsonl');
  fs.writeFileSync(empty, '');
  const garbage = path.join(dir, 'garbage.jsonl');
  fs.writeFileSync(garbage, 'not json\n[1]\nnull\n{"type":"assistant"}\n');
  for (const file of [path.join(dir, 'missing.jsonl'), dir, empty, garbage, undefined, 42]) {
    assert.strictEqual(contextFromTranscript(file), null, String(file));
  }
});

test('contextOf takes the freshest reading and the window of the status line', () => {
  const heartbeat = reading(1, { tool: 'Bash', contextTokens: 60000, baseTokens: 41000 });
  const statusline = reading(2, { contextTokens: 58000, windowTokens: 1000000, baseTokens: 42000 });
  const options = { role: 'lead', config, now: NOW, active: true };

  const fromHeartbeat = contextOf({ heartbeat, statusline, failure: null }, options);
  assert.deepStrictEqual(
    [fromHeartbeat.tokens, fromHeartbeat.windowTokens, fromHeartbeat.baseTokens, fromHeartbeat.at],
    [60000, 1000000, 41000, heartbeat.at],
  );

  const newer = reading(0, { contextTokens: 61000, windowTokens: 1000000, baseTokens: 42000 });
  const fromStatusline = contextOf({ heartbeat, statusline: newer, failure: null }, options);
  assert.deepStrictEqual([fromStatusline.tokens, fromStatusline.baseTokens], [61000, 41000]);

  // A status line read before any answer has no context: the heartbeat, older, is taken.
  const first = reading(0, { contextTokens: null, windowTokens: 1000000, baseTokens: null });
  const withoutContext = contextOf({ heartbeat, statusline: first, failure: null }, options);
  assert.deepStrictEqual([withoutContext.tokens, withoutContext.windowTokens], [60000, 1000000]);

  // Without a heartbeat, the base is the status line's, else the context itself.
  assert.strictEqual(contextOf({ heartbeat: null, statusline, failure: null }, options).baseTokens, 42000);
  const bare = contextOf({ heartbeat: reading(1, { contextTokens: 50000 }), statusline: null, failure: null }, options);
  assert.deepStrictEqual([bare.baseTokens, bare.windowTokens], [50000, null]);

  assert.strictEqual(contextOf({ heartbeat: null, statusline: null, failure: null }, options), null);
  assert.strictEqual(contextOf({ heartbeat: reading(1, { tool: '(stop)', contextTokens: null }), statusline: first }, options), null);
});

test('contextOf ignores a reading older than 30 min only for an active session', () => {
  const readings = { heartbeat: reading(31, { contextTokens: 60000, baseTokens: 41000 }), statusline: null, failure: null };
  assert.strictEqual(contextOf(readings, { role: 'lead', config, now: NOW, active: true }), null);
  assert.strictEqual(contextOf(readings, { role: 'lead', config, now: NOW, active: false }).tokens, 60000);
  const recent = { ...readings, heartbeat: reading(29, { contextTokens: 60000, baseTokens: 41000 }) };
  assert.strictEqual(contextOf(recent, { role: 'lead', config, now: NOW, active: true }).tokens, 60000);
});

test('contextOf fills a configuration without context from the defaults', () => {
  const readings = { heartbeat: reading(1, { contextTokens: 50000, baseTokens: 40000 }), statusline: null, failure: null };
  const old = structuredClone(DEFAULTS);
  delete old.context;
  assert.deepStrictEqual(pick(contextOf(readings, { role: 'lead', config: old, now: NOW, active: true })), [190000, 228000]);
  // A partial setting keeps the other defaults.
  const partial = { ...old, context: { budgets: { lead: 100000 } } };
  assert.deepStrictEqual(pick(contextOf(readings, { role: 'lead', config: partial, now: NOW, active: true })), [140000, 168000]);
  assert.deepStrictEqual(pick(contextOf(readings, { role: 'crew', config: partial, now: NOW, active: true })), [290000, 348000]);
});

function pick(context) {
  return [context.soft, context.hard];
}

test('thresholds follow base + budget, capped by a measured window, and the hard margin', () => {
  const thresholds = (role, windowTokens) => {
    const heartbeat = reading(1, { contextTokens: 50000, baseTokens: 40000 });
    const statusline = windowTokens ? reading(2, { contextTokens: 45000, windowTokens, baseTokens: 40000 }) : null;
    return pick(contextOf({ heartbeat, statusline, failure: null }, { role, config, now: NOW, active: true }));
  };
  assert.deepStrictEqual(thresholds('lead', 1000000), [190000, 228000]);
  assert.deepStrictEqual(thresholds('lead', 200000), [80000, 96000]);
  assert.deepStrictEqual(thresholds('lead', null), [190000, 228000]);
  assert.deepStrictEqual(thresholds('crew', 1000000), [290000, 348000]);
});

test('an answer without input tokens is no reading of the transcript', () => {
  const dir = tmpDir();
  // A synthetic answer (an API error, a rate limit) has an empty usage: the answer before it counts.
  const empty = JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    message: { usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } },
  }) + '\n';
  const after = path.join(dir, 'after.jsonl');
  fs.writeFileSync(after, answerLine(50000) + empty);
  assert.strictEqual(contextFromTranscript(after), 50000);
  const only = path.join(dir, 'only.jsonl');
  fs.writeFileSync(only, empty + answerLine(0));
  assert.strictEqual(contextFromTranscript(only), null);
});
