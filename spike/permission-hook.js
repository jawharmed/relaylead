// Hook PermissionRequest : liste blanche ; tout le reste est refusé et devient une question.
const { readStdinJson, writeJson, out } = require('./lib');
const ALLOWED = [/^node spike\//, /^node .*spike\//, /^git (status|add|commit)\b/];
const MSG = 'Refusé par Relaylead : une question a été créée pour l\'humain. Continue avec le reste de la tâche.';
readStdinJson().then((j) => {
  const text = j.tool_input?.command || j.tool_input?.file_path || JSON.stringify(j.tool_input || {});
  if (ALLOWED.some((r) => r.test(text))) {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }));
    return;
  }
  writeJson(out('questions', `${Date.now()}.json`), { at: new Date().toISOString(), hook: 'PermissionRequest', tool: j.tool_name, text });
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: MSG } } }));
});
