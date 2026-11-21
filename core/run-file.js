// Runs a program and waits for it, like execFileSync, but returns as soon as the program itself
// has ended. execFileSync reads the output through pipes and waits until every process holding
// them has closed them: a git hook, a credential helper or a background gc started by git keeps
// them open after git has ended, and relaylead would wait for it (and hold its locks) until the
// timeout. Here the output goes to temporary files instead, read back once the program has ended.
//
// Except on macOS with a libuv older than 1.45 (Node 18): there, spawnSync may miss the end of a
// program that ends very fast and wait forever, timeout included, unless an open pipe wakes it up
// (libuv/libuv#3893, issue #53). The output then goes through pipes, always with a timeout: when
// it fires, Node closes the pipes, so a process left behind holding them delays relaylead until
// the timeout, never longer.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// A git command that does not end in this time is stopped and fails. Without a bound, a git that
// hangs would block relaylead forever, and with it the start lock that every start and delivery of
// the mission waits for. Tests shorten it.
const gitTimeoutMs = () => Number(process.env.RELAYLEAD_GIT_TIMEOUT_MS) || 5 * 60 * 1000;

// Whether spawnSync needs a pipe to see the end of a program: macOS with libuv before 1.45.
function needsPipes(platform, uvVersion) {
  if (platform !== 'darwin') return false;
  const [major, minor] = uvVersion.split('.').map(Number);
  return major < 1 || (major === 1 && minor < 45);
}

// `options` are those of execFileSync. Each 'pipe' of `stdio` (the default) becomes a file.
// Returns stdout; throws like execFileSync: `status`, `signal`, `stdout` and `stderr` on the error,
// `code` 'ETIMEDOUT' when the timeout stopped the program.
function runFileSync(file, args, options = {}) {
  const stdio = typeof options.stdio === 'string' || options.stdio === undefined
    ? [options.stdio || 'pipe', options.stdio || 'pipe', options.stdio || 'pipe']
    : options.stdio;
  if (needsPipes(process.platform, process.versions.uv)) return runWithPipes(file, args, options, stdio);
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
    return outcome(file, args, result, read(1), read(2));
  } finally {
    for (const fd of fds) fs.closeSync(fd);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // On Windows, a process left behind may still hold the files: the system cleans tmp later.
    }
  }
}

// The output through pipes, read only for the 'pipe' entries of `stdio`; the caller's timeout or
// gitTimeoutMs(). No size limit, like the files of the other way.
function runWithPipes(file, args, options, stdio) {
  // The output is read as bytes (encoding 'buffer'), and spawnSync would decode a text `input` with
  // that same encoding, which is no text encoding: the input goes as bytes too.
  const input = typeof options.input === 'string' ? Buffer.from(options.input) : options.input;
  const result = spawnSync(file, args, {
    ...options,
    input,
    stdio: [stdio[0], 'pipe', 'pipe'],
    encoding: 'buffer',
    timeout: options.timeout || gitTimeoutMs(),
    maxBuffer: Infinity,
  });
  const read = (index) => {
    if (stdio[index] !== 'pipe') return null;
    // No output at all when the program could not start (git missing, for instance).
    const content = result.output ? result.output[index] : Buffer.alloc(0);
    return options.encoding && options.encoding !== 'buffer' ? content.toString(options.encoding) : content;
  };
  return outcome(file, args, result, read(1), read(2));
}

// Returns stdout, or throws like execFileSync.
function outcome(file, args, result, stdout, stderr) {
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
}

module.exports = { runFileSync, gitTimeoutMs, needsPipes };
