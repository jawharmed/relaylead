// StopFailure hook: the turn ended on an error (a usage limit: rate_limit). Records it in
// failures/<shortId>.json for the watcher. Prints nothing and never fails: an error writes nothing.
const { readHookInput } = require('../guard');
const { shortIdOf, recordFailure } = require('../readings');

try {
  const mission = process.env.RELAYLEAD_MISSION;
  const input = readHookInput();
  const shortId = input && shortIdOf(input.session_id);
  if (/^[a-z0-9-]+$/.test(mission || '') && shortId) recordFailure(mission, shortId, input);
} catch {
  // A reading is a record only.
}
