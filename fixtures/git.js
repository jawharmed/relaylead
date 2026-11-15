// Temporary git repositories for the delivery tests.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tmpDir } = require('./helpers');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// CI runners have no git user. Set in process.env, so the fake agents spawned by the tests get it too.
function setTestGitIdentity() {
  process.env.GIT_AUTHOR_NAME = 'Relaylead Test';
  process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
  process.env.GIT_COMMITTER_NAME = 'Relaylead Test';
  process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
}

// A repository on branch main with `files` ({relative path: text}) committed. Its path contains
// a space, like many Windows user folders.
function gitRepo(files) {
  setTestGitIdentity();
  const dir = fs.realpathSync.native(tmpDir('relaylead project-'));
  git(dir, 'init', '-q', '-b', 'main');
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

module.exports = { git, gitRepo };
