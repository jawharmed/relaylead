// Stop hook: the session is about to end its turn. Its heartbeat says so (tool "(stop)"), then mail
// waiting for it keeps the turn going, as the reason given to the model. The mail is taken, so the
// next Stop lets the turn end. Prints nothing without mail and never fails: an error writes nothing.
const { readHookInput } = require('../guard');
const { shortIdOf, contextFromTranscript, recordHeartbeat } = require('../readings');
const { passMail } = require('../mailbox');

try {
  const mission = process.env.RELAYLEAD_MISSION;
  const input = readHookInput();
  const shortId = input && shortIdOf(input.session_id);
  if (/^[a-z0-9-]+$/.test(mission || '') && shortId) {
    recordHeartbeat(mission, shortId, { tool: '(stop)', contextTokens: contextFromTranscript(input.transcript_path) });
    passMail(mission, shortId, (text) => ({ decision: 'block', reason: text }));
  }
} catch {
  // Without its heartbeat or its mail, the turn ends: the watcher wakes the session later.
}
