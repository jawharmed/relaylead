// Stands in for osascript in the tests (RELAYLEAD_NOTIFY_BIN): appends its arguments, as one JSON
// line, to the file named by RELAYLEAD_NOTIFY_LOG.
const fs = require('node:fs');

fs.appendFileSync(process.env.RELAYLEAD_NOTIFY_LOG, JSON.stringify(process.argv.slice(2)) + '\n');
