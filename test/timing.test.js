const test = require('node:test');
const assert = require('node:assert');
const { retrySync } = require('../core/timing');

test('retrySync stops retrying once the budget is spent', () => {
  let calls = 0;
  const start = Date.now();
  assert.throws(
    () =>
      retrySync(
        () => {
          calls++;
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        },
        { retryIf: () => true, budgetMs: 100, delayMs: () => 10 },
      ),
    (err) => err.code === 'EBUSY',
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 100 && elapsed < 2000, `elapsed ${elapsed} ms`);
  assert.ok(calls > 1);
});

test('retrySync gives up at once on an error it does not retry', () => {
  let calls = 0;
  assert.throws(
    () =>
      retrySync(
        () => {
          calls++;
          throw new Error('no');
        },
        { retryIf: () => false, budgetMs: 1000, delayMs: () => 10 },
      ),
    /no/,
  );
  assert.strictEqual(calls, 1);
});
