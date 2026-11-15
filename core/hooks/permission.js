// PermissionRequest hook: answers every permission prompt so no session waits for a human. Allows
// what guard.allow or the profile's tools (RELAYLEAD_ALLOW, a JSON array) list, and denies the rest
// without asking a question (asking the user belongs to lot 3).
const { isAllowed, denyMessage, loadMissionGuard, readHookInput, writeJournal } = require('../guard');

function profileTools() {
  try {
    const tools = JSON.parse(process.env.RELAYLEAD_ALLOW || '[]');
    return Array.isArray(tools) ? tools : [];
  } catch {
    return [];
  }
}

// Reason to refuse the request, or null to allow it.
function refusal(input, patterns) {
  if (!input) return 'unreadable hook input';
  if (isAllowed(input, patterns)) return null;
  return `${input.tool_name === 'Bash' ? 'Bash command' : input.tool_name} not in the allowed tools`;
}

const { mission, guard } = loadMissionGuard();
const input = readHookInput();
const reason = refusal(input, [...guard.allow, ...profileTools()]);
const decision = reason ? { behavior: 'deny', message: denyMessage(reason) } : { behavior: 'allow' };
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }) + '\n');
if (reason) writeJournal(mission, input ? input.tool_name : '?', reason);
