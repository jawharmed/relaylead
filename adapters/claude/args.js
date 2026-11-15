// Translates a profile into `claude` launch arguments. Pure: nothing is run here.
const MIN_VERSION = '2.1.325';
const ALL_MODE_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];

// The tools a session may use: the profile's own, or the usual set in 'all' mode.
function allowedTools(profile, permissionMode) {
  if (permissionMode === 'all') return ALL_MODE_TOOLS;
  // --allowedTools takes several values: with none, it would swallow the next option.
  if (profile.tools.length === 0) {
    const err = new Error(`profile "${profile.name}" lists no tools: an allowlist profile must list its tools`);
    err.code = 'profile-without-tools';
    throw err;
  }
  return profile.tools;
}

// Order matters: --allowedTools takes several values, so it goes first and nothing
// after it can be swallowed as a tool. The prompt goes last.
function buildLaunchArgs({ profile, name, settingsFile, permissionMode, prompt }) {
  const args = ['--allowedTools', ...allowedTools(profile, permissionMode)];
  args.push('--permission-mode', 'acceptEdits');
  args.push('--bg', '--name', name);
  if (profile.model) args.push('--model', profile.model);
  if (profile.effort) args.push('--effort', profile.effort);
  if (profile.instructions) args.push('--append-system-prompt', profile.instructions);
  args.push('--settings', settingsFile, '--setting-sources', 'project,local', '--strict-mcp-config');
  args.push(prompt);
  return args;
}

function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text));
  return match ? match.slice(1).map(Number) : null;
}

// True when the version in `text` (e.g. "2.1.330 (Claude Code)") is at least `min`.
function compareVersion(text, min = MIN_VERSION) {
  const found = parseVersion(text);
  if (!found) return false;
  const wanted = parseVersion(min);
  for (let i = 0; i < 3; i++) {
    if (found[i] !== wanted[i]) return found[i] > wanted[i];
  }
  return true;
}

module.exports = { MIN_VERSION, ALL_MODE_TOOLS, allowedTools, buildLaunchArgs, compareVersion };
