// Runs a program and waits for it, like execFileSync, but returns as soon as the program itself
// has ended. execFileSync reads the output through pipes and waits until every process holding
// them has closed them: a git hook, a credential helper or a background gc started by git keeps
// them open after git has ended, and relaylead would wait for it (and hold its locks) until the
// timeout. Here the output goes to temporary files instead, read back once the program has ended.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// A git command that does not end in this time is stopped and fails. Without a bound, a git that
// hangs would block relaylead forever, and with it the start lock that every start and delivery of
// the mission waits for. Tests shorten it.
const gitTimeoutMs = () => Number(process.env.RELAYLEAD_GIT_TIMEOUT_MS) || 5 * 60 * 1000;

// `options` are those of execFileSync. Each 'pipe' of `stdio` (the default) becomes a file.
// Returns stdout; throws like execFileSync: `status`, `signal`, `stdout` and `stderr` on the error,
// `code` 'ETIMEDOUT' when the timeout stopped the program.
function runFileSync(file, args, options = {}) {
  const stdio = typeof options.stdio === 'string' || options.stdio === undefined
    ? [options.stdio || 'pipe', options.stdio || 'pipe', options.stdio || 'pipe']
    : options.stdio;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaylead-output-'));
  const files = [null, path.join(dir, 'stdout'), path.join(dir, 'stderr')];
  const fds = [];
  try {
    const redirected = stdio.map((how, index) => {
      if (index === 0 || how !== 'pipe') return how;
      const fd = fs.openSync(files[index], 'w+');
      fds.push(fd);
      return fd;
    });
    const result = spawnSync(file, args, { ...options, stdio: redirected });
    const read = (index) => {
      if (stdio[index] !== 'pipe') return null;
      const content = fs.readFileSync(files[index]);
      return options.encoding && options.encoding !== 'buffer' ? content.toString(options.encoding) : content;
    };
    const stdout = read(1);
    const stderr = read(2);
    if (result.error) throw Object.assign(result.error, { status: result.status, signal: result.signal, stdout, stderr });
    if (result.status !== 0) {
      // The same message as execFileSync.
      const detail = stderr && stderr.length > 0 ? `\n${stderr}` : '';
      throw Object.assign(new Error(`Command failed: ${[file, ...args].join(' ')}${detail}`), {
        status: result.status,
        signal: result.signal,
        stdout,
        stderr,
      });
    }
    return stdout;
  } finally {
    for (const fd of fds) fs.closeSync(fd);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // On Windows, a process left behind may still hold the files: the system cleans tmp later.
    }
  }
}

module.exports = { runFileSync, gitTimeoutMs };
