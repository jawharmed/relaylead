const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { recordUsage, readUsage, usageFile } = require('../core/usage');
const { writeJson } = require('../core/store');
const { tmpDir } = require('../fixtures/helpers');

const MINUTE = 60 * 1000;
// What the status line gets on a Max account: resets_at in seconds since 1970.
const RATE_LIMITS = {
  five_hour: { used_percentage: 42, resets_at: 1795000000 },
  seven_day: { used_percentage: 12.5, resets_at: 1795400000 },
};

function freshHome() {
  process.env.RELAYLEAD_HOME = tmpDir('relaylead-home-');
}

test('the usage written by the status line is read back, the reset times in ISO', () => {
  freshHome();
  recordUsage('claude', RATE_LIMITS);
  const usage = readUsage('claude');
  assert.deepStrictEqual(usage.fiveHour, { percent: 42, resetsAt: new Date(1795000000 * 1000).toISOString() });
  assert.deepStrictEqual(usage.sevenDay, { percent: 12.5, resetsAt: new Date(1795400000 * 1000).toISOString() });
  // One window missing (an account without it) is null.
  recordUsage('claude', { five_hour: RATE_LIMITS.five_hour });
  assert.strictEqual(readUsage('claude').sevenDay, null);
});

test('a usage older than 30 min is no usage', () => {
  freshHome();
  const at = Date.now() - 31 * MINUTE;
  writeJson(usageFile(), { claude: { at: new Date(at).toISOString(), fiveHour: { percent: 90, resetsAt: null }, sevenDay: null } });
  assert.strictEqual(readUsage('claude'), null);
  assert.ok(readUsage('claude', at + 29 * MINUTE));
});

test('an input without rate limits writes nothing, and a malformed one does not throw', () => {
  freshHome();
  for (const input of [undefined, null, {}, 'text', { five_hour: 'x' }, { five_hour: { used_percentage: 'high' } }]) {
    recordUsage('claude', input);
  }
  assert.strictEqual(fs.existsSync(usageFile()), false);
  fs.mkdirSync(path.dirname(usageFile()), { recursive: true });
  fs.writeFileSync(usageFile(), '{ broken');
  assert.strictEqual(readUsage('claude'), null);
  recordUsage('claude', RATE_LIMITS);
  assert.strictEqual(readUsage('claude').fiveHour.percent, 42);
});
