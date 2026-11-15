#!/usr/bin/env node
const { run } = require('../core/cli');

run(process.argv.slice(2), {
  out: process.stdout,
  err: process.stderr,
  env: process.env,
  cwd: process.cwd(),
}).then((code) => {
  process.exitCode = code;
});
