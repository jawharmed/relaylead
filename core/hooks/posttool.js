// PostToolUse hook: after each action of the session, its heartbeat, with the context its transcript
// gives. Prints nothing and never fails: an error writes nothing.
const { readHookInput } = require('../guard');
const { shortIdOf, contextFromTranscript, recordHeartbeat } = require('../readings');

try {
  const mission = process.env.RELAYLEAD_MISSION;
  const input = readHookInput();
  const shortId = input && shortIdOf(input.session_id);
  if (/^[a-z0-9-]+$/.test(mission || '') && shortId) {
    recordHeartbeat(mission, shortId, { tool: input.tool_name, contextTokens: contextFromTranscript(input.transcript_path) });
  }
} catch {
  // A reading is a record only: the session goes on without it.
}
