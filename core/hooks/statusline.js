// The measuring status line: Claude Code calls it after each answer of the model, with the exact
// context and the size of the window (core/readings.js), and the usage of the account (core/usage.js). Prints a blank line, as nobody looks at a
// background session, and never fails: an error writes nothing.
const { readHookInput } = require('../guard');
const { shortIdOf, recordStatusline } = require('../readings');
const { recordUsage } = require('../usage');

try {
  const mission = process.env.RELAYLEAD_MISSION;
  const input = readHookInput();
  const shortId = input && shortIdOf(input.session_id);
  if (/^[a-z0-9-]+$/.test(mission || '') && shortId) {
    recordStatusline(mission, shortId, input);
    recordUsage('claude', input.rate_limits);
  }
} catch {
  // A reading is a record only: the session goes on without it.
}
process.stdout.write('\n');
