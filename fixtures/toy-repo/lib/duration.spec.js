const test = require('node:test');
const assert = require('node:assert');
const { toMilliseconds } = require('../lib/duration');

test('a duration in words becomes milliseconds', () => {
  assert.strictEqual(toMilliseconds('2 days'), 172800000);
});
