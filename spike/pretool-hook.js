// Hook PreToolUse : refuse ce qui touche à « rl-forbidden », dans tous les modes d'autorisation.
const { readStdinJson, writeJson, out } = require('./lib');
const MSG = 'Refusé par Relaylead : une question a été créée pour l\'humain. Continue avec le reste de la tâche.';
readStdinJson().then((j) => {
  const text = JSON.stringify(j.tool_input || {});
  if (!text.includes('rl-forbidden')) return;
  writeJson(out('questions', `${Date.now()}.json`), { at: new Date().toISOString(), hook: 'PreToolUse', tool: j.tool_name, text });
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: MSG } }));
});
