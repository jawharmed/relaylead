// Calls to the GitHub CLI `gh`, never through a shell. gh reads its own login (`gh auth login`).
const { runFileSync, gitTimeoutMs } = require('./run-file');
const { codedError } = require('./messages');

// Runs `gh <args>` in `cwd` and returns its output without the spaces around it. gh asks nothing
// (GH_PROMPT_DISABLED) and prints no colours (NO_COLOR).
function gh(args, { cwd } = {}) {
  try {
    const output = runFileSync('gh', args, {
      cwd,
      encoding: 'utf8',
      timeout: gitTimeoutMs(),
      windowsHide: true,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
    });
    return output.trim();
  } catch (err) {
    if (err.code === 'ENOENT') throw codedError('gh-missing', {});
    const detail = String(err.stderr || err.stdout || err.message).trim();
    if (detail.includes('gh auth login')) throw codedError('gh-not-authenticated', {});
    throw codedError('gh-failed', { args: args.join(' '), detail });
  }
}

// Like gh(), for a command printing JSON (--json).
function ghJson(args, options) {
  return JSON.parse(gh(args, options));
}

// Throws gh-missing or gh-not-authenticated when gh cannot be used.
function checkGh({ cwd } = {}) {
  gh(['auth', 'status'], { cwd });
}

module.exports = { gh, ghJson, checkGh };
