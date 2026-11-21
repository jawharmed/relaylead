// PreToolUse hook: refuses dangerous actions whatever the permission mode. Prints nothing to let
// the action go on. Run by Claude Code as `node pretool.js` with the tool call as JSON on stdin.
// An action that cannot be undone is refused too, and the user is asked about it (question
// q-irr-<hash>): once answered "Allow once", that exact action goes through a single time.
const { checkToolUse, actionText, actionHash, denyMessage, loadMissionGuard, readHookInput, writeJournal } = require('../guard');
const { askQuestion } = require('../questions');
const { consumeGrant } = require('../grants');

// The decision for an irreversible action: allowed once by the user's answer, or refused with a
// question to the user (asking again gives the same question: never a second one). Without a
// mission, or when the question cannot be written, refused as it is.
function irreversibleDecision(mission, input, result) {
  if (!mission) return result;
  try {
    const text = actionText(input);
    const key = `irr-${actionHash(input.tool_name, text)}`;
    const id = `q-${key}`;
    if (consumeGrant(mission, id, { once: ['Allow once'] }).allowed) return { decision: 'allow', grantedBy: id };
    const context = `Tool ${input.tool_name}, session ${input.session_id || 'unknown'}, in ${input.cwd || 'unknown'}: ${result.reason}`;
    askQuestion(mission, { key, kind: 'irreversible', text, context, options: ['Allow once', 'Refuse'], recommended: 2 });
    return { ...result, question: id };
  } catch {
    return result;
  }
}

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
  if (result.irreversible) result = irreversibleDecision(mission, input, result);
  if (result.decision === 'deny') {
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: denyMessage(result.reason, result.question),
      },
    };
    process.stdout.write(JSON.stringify(output) + '\n');
    writeJournal(mission, input.tool_name, result.reason);
  } else if (result.grantedBy) {
    writeJournal(mission, input.tool_name, `allowed once by the user (question ${result.grantedBy})`);
  }
}
