// The measuring status line: Claude Code calls it after each answer of the model, with the exact
// context and the size of the window (core/readings.js). Prints a blank line, as nobody looks at a
// background session, and never fails: an error writes nothing.
const { readHookInput } = require('../guard');
const { shortIdOf, recordStatusline } = require('../readings');

try {
  const mission = process.env.RELAYLEAD_MISSION;
  const input = readHookInput();
  const shortId = input && shortIdOf(input.session_id);
  if (/^[a-z0-9-]+$/.test(mission || '') && shortId) recordStatusline(mission, shortId, input);
} catch {
  // A reading is a record only: the session goes on without it.
}
process.stdout.write('\n');
