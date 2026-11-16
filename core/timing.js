// Waits and retries shared by the whole package.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Blocks the thread: for code that cannot be async (git calls, file writes).
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Runs `action` and returns its result. On an error, tries again while retryIf(err) is true and
// less than budgetMs has passed since the first try, waiting delayMs(attempt) between two tries;
// otherwise throws the last error.
function retrySync(action, { retryIf, budgetMs, delayMs }) {
  const start = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      return action();
    } catch (err) {
      if (!retryIf(err) || Date.now() - start >= budgetMs) throw err;
      sleepSync(delayMs(attempt));
    }
  }
}

module.exports = { sleep, sleepSync, retrySync };
