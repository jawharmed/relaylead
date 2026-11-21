const test = require('node:test');
const assert = require('node:assert');
const { gh, ghJson, checkGh } = require('../core/github');
const { fakeGh, issue } = require('../fixtures/github');
const { tmpDir } = require('../fixtures/helpers');

test('gh runs the gh of the PATH and returns its output', (t) => {
  const github = fakeGh(t, { issues: [issue(1, 'one')] });
  const issues = ghJson(['issue', 'list', '--json', 'number,title']);
  assert.deepStrictEqual(issues, [{ number: 1, title: 'one' }]);
  checkGh();
  assert.deepStrictEqual(github.calls().at(-1), ['auth', 'status']);
});

test('no gh on the PATH gives gh-missing', (t) => {
  fakeGh(t, {});
  process.env.PATH = tmpDir('relaylead-empty-');
  assert.throws(() => checkGh(), { code: 'gh-missing' });
});

test('a failed gh gives gh-failed with its output, or gh-not-authenticated', (t) => {
  fakeGh(t, {});
  process.env.FAKE_GH_FAIL = 'issue close';
  t.after(() => delete process.env.FAKE_GH_FAIL);
  assert.throws(() => gh(['issue', 'close', '3']), (err) => {
    assert.strictEqual(err.code, 'gh-failed');
    assert.strictEqual(err.vars.args, 'issue close 3');
    assert.match(err.vars.detail, /fake failure of gh issue close 3/);
    return true;
  });
  process.env.FAKE_GH_NOT_LOGGED_IN = '1';
  t.after(() => delete process.env.FAKE_GH_NOT_LOGGED_IN);
  assert.throws(() => checkGh(), { code: 'gh-not-authenticated' });
});
