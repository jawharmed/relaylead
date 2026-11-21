// Run by Claude Code itself, as the `apiKeyHelper` of a session's settings: prints the key of the
// file given as its only argument, which Claude Code sends to the API. Prints nothing else, and exits
// 1 when the file is missing or empty (Claude Code then says its apiKeyHelper is failing).
const { readKey } = require('./auth');

const key = readKey(process.argv[2] || '');
if (key) process.stdout.write(key + '\n');
else process.exitCode = 1;
