const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { contextTokens, writeJson } = require('./lib');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));

test('contextTokens renvoie null sans réponse assistant', () => {
  const f = path.join(tmp(), 't.jsonl');
  fs.writeFileSync(f, JSON.stringify({ type: 'user', message: { content: 'x' } }) + '\n');
  assert.strictEqual(contextTokens(f), null);
});

test('writeJson écrit atomiquement et ne laisse pas de fichier temporaire', () => {
  const dir = tmp();
  const f = path.join(dir, 'a', 'b.json');
  writeJson(f, { x: 1 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { x: 1 });
  assert.deepStrictEqual(fs.readdirSync(path.dirname(f)), ['b.json']);
});

const fixture = path.join(__dirname, 'fixtures', 'transcript.jsonl');
test('contextTokens sur un vrai transcript donne le total de la dernière réponse', { skip: !fs.existsSync(fixture) }, () => {
  const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'expected.json'), 'utf8'));
  const r = contextTokens(fixture);
  assert.strictEqual(r.tokens, expected.tokens);
  assert.strictEqual(r.model, expected.model);
});
