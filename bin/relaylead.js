#!/usr/bin/env node
const { run } = require('../core/cli');

// A closed pipe (`relaylead init | head -2`) is not an error: the reader has what it wanted.
process.stdout.on('error', (err) => {
  if (err.code !== 'EPIPE') throw err;
  process.exit(process.exitCode || 0);
});

run(process.argv.slice(2), {
  out: process.stdout,
  err: process.stderr,
  env: process.env,
  cwd: process.cwd(),
}).then((code) => {
  process.exitCode = code;
});
