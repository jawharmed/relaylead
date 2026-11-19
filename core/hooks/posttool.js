// PostToolUse hook: after each action of the session, its heartbeat, with the context its transcript
// gives, then its mail, passed on as additional context. Prints nothing without mail and never
// fails: an error writes nothing.
// A PostToolUse run inside a helper agent would take the mail of the whole session; no profile has
// a tool to start a helper agent today.
const { readHookInput } = require('../guard');
const { shortIdOf, contextFromTranscript, recordHeartbeat } = require('../readings');
const { passMail } = require('../mailbox');

try {
  const mission = process.env.RELAYLEAD_MISSION;
  const input = readHookInput();
  const shortId = input && shortIdOf(input.session_id);
  if (/^[a-z0-9-]+$/.test(mission || '') && shortId) {
    recordHeartbeat(mission, shortId, { tool: input.tool_name, contextTokens: contextFromTranscript(input.transcript_path) });
    passMail(mission, shortId, (text) => ({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }));
  }
} catch {
  // A reading is a record only, and mail not passed on waits for the next action: the session goes on.
}
