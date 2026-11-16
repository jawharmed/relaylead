// Helper for the concurrency test: writes the same file many times.
// Usage: node writer.js <file> <label> <count>
const { writeJson } = require('../core/store');

const fs = require('node:fs');

const [file, label, count] = process.argv.slice(2);
try {
  for (let i = 0; i < Number(count); i++) {
    writeJson(file, { writer: label, n: i, padding: 'x'.repeat(5000) });
  }
} catch (err) {
  // Written synchronously: on Windows, an uncaught error's text can be lost when the process ends.
  fs.writeSync(2, `${err.code || ''} ${err.stack}\n`);
  process.exitCode = 1;
}
