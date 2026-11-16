// `npm test`: runs `node --test` with a watchdog. Node 18 has no --test-timeout and prints a test
// file's results only when the file ends: a file that hangs would block the run, and the CI job,
// without a word. After RELAYLEAD_TEST_WATCHDOG_MINUTES (10 by default), the watchdog lists the
// processes still running (the test files, relaylead, git) and stops the run, which then fails.
const { spawn, execFileSync } = require('node:child_process');

const minutes = Number(process.env.RELAYLEAD_TEST_WATCHDOG_MINUTES) || 10;
const posix = process.platform !== 'win32';

// Its own process group on POSIX, so the whole run (the test files and what they started) can be
// stopped at once.
const runner = spawn(process.execPath, ['--test', ...process.argv.slice(2)], { stdio: 'inherit', detached: posix });

function stopRunner() {
  try {
    if (posix) process.kill(-runner.pid, 'SIGKILL');
    else runner.kill('SIGKILL');
  } catch {
    // already ended
  }
}

// The processes of the run: those of its process group, and the detached ones (fake agents, git in
// a relaylead-… temporary folder) found by name. With their parent, age and state (Z: ended but
// not reaped by its parent).
function runningProcesses() {
  if (!posix) return '(no process list on Windows)';
  try {
    const columns = ['-A', '-o', 'pid,ppid,pgid,etime,stat,command'];
    const [header, ...rows] = execFileSync('ps', columns, { encoding: 'utf8', timeout: 10000 }).split('\n');
    const ours = rows.filter((row) => row.trim().split(/\s+/)[2] === String(runner.pid) || /relaylead/i.test(row));
    return [header, ...ours].join('\n');
  } catch (err) {
    return `(ps failed: ${err.message})`;
  }
}

const watchdog = setTimeout(() => {
  const processes = runningProcesses();
  const files = new Set(processes.split('\n').map((row) => (row.match(/\S*\.test\.js/) || [])[0]).filter(Boolean));
  process.stderr.write(`\nThe tests did not end within ${minutes} min.\n`);
  process.stderr.write(`Test files still running:\n${[...files].join('\n') || '(unknown)'}\n`);
  process.stderr.write(`Processes:\n${processes}\n`);
  stopRunner();
  process.exit(1);
}, minutes * 60 * 1000);

// Ctrl-C does not reach a detached group: it is passed on.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopRunner();
    process.exit(1);
  });
}

runner.on('exit', (code) => {
  clearTimeout(watchdog);
  process.exit(code === null ? 1 : code);
});
