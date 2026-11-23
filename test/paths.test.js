const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { slug, home, missionDir } = require('../core/paths');

test('slug turns "My Project 2" into "my-project-2"', () => {
  assert.strictEqual(slug('My Project 2'), 'my-project-2');
});

test('slug merges dashes, limits length and rejects empty text', () => {
  assert.strictEqual(slug('  a   --  b!! '), 'a-b');
  assert.strictEqual(slug('x'.repeat(60)).length, 40);
  assert.throws(() => slug(''));
});

test('slug removes accents instead of dropping the letters', () => {
  assert.strictEqual(slug('Équipe-essai'), 'equipe-essai');
  assert.strictEqual(slug('été'), 'ete');
  assert.strictEqual(slug('thé'), 'the');
});

test('home follows RELAYLEAD_HOME at call time', () => {
  const before = process.env.RELAYLEAD_HOME;
  process.env.RELAYLEAD_HOME = path.join('some', 'dir');
  assert.strictEqual(home(), path.join('some', 'dir'));
  assert.strictEqual(missionDir('m'), path.join('some', 'dir', 'missions', 'm'));
  if (before === undefined) delete process.env.RELAYLEAD_HOME;
  else process.env.RELAYLEAD_HOME = before;
});
