// PreToolUse hook: refuses dangerous actions whatever the permission mode. Prints nothing to let
// the action go on. Run by Claude Code as `node pretool.js` with the tool call as JSON on stdin.
const { checkToolUse, denyMessage, loadMissionGuard, readHookInput, writeJournal } = require('../guard');

const { mission, guard, stateDir } = loadMissionGuard();
const input = readHookInput();
if (!input) {
  writeJournal(mission, 'unknown', 'unreadable hook input');
} else {
  let result;
  try {
    result = checkToolUse(input, guard, stateDir);
  } catch {
    // A crashing hook would let the action through: refuse what the guard cannot judge.
    result = { decision: 'deny', reason: 'guard error' };
  }
  if (result.decision === 'deny') {
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: denyMessage(result.reason),
      },
    };
    process.stdout.write(JSON.stringify(output) + '\n');
    writeJournal(mission, input.tool_name, result.reason);
  }
}
