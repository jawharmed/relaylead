// Helper for the concurrency test: writes the same file many times.
// Usage: node writer.js <file> <label> <count>
const { writeJson } = require('../core/store');

const [file, label, count] = process.argv.slice(2);
for (let i = 0; i < Number(count); i++) {
  writeJson(file, { writer: label, n: i, padding: 'x'.repeat(5000) });
}
