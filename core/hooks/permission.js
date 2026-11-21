// PermissionRequest hook: answers every permission prompt so no session waits for a human. Allows
// what guard.allow or the profile's tools (RELAYLEAD_ALLOW, a JSON array) list. The rest is denied,
// and the user is asked (question q-perm-<hash>, about the whole command): "Allow once" lets that
// exact request through a single time, "Always allow in this mission" every time.
const { isAllowed, actionText, actionHash, denyMessage, loadMissionGuard, readHookInput, writeJournal } = require('../guard');
const { askQuestion, listQuestions } = require('../questions');
const { consumeGrant } = require('../grants');

// Past this many open permission questions in a mission, a request is denied without a new one.
const MAX_OPEN_PERMISSION_QUESTIONS = 10;

function profileTools() {
  try {
    const tools = JSON.parse(process.env.RELAYLEAD_ALLOW || '[]');
    return Array.isArray(tools) && tools.every((tool) => typeof tool === 'string') ? tools : [];
  } catch {
    return [];
  }
}

// Reason to refuse the request, or null to allow it.
function refusal(input, patterns) {
  if (!input) return 'unreadable hook input';
  try {
    if (isAllowed(input, patterns)) return null;
  } catch {
    return 'guard error'; // never leave the prompt waiting
  }
  const tool = input.tool_name || 'unknown';
  return `${tool === 'Bash' ? 'Bash command' : tool} not in the allowed tools`;
}

// {allowed, question, note} for a request out of the lists: allowed by the user's answer, or denied
// with a question (the same one when asked again). Without a mission, denied as it is.
function askUser(mission, input, reason) {
  if (!mission) return { allowed: false };
  const text = actionText(input);
  const key = `perm-${actionHash(input.tool_name, text)}`;
  const id = `q-${key}`;
  const grant = consumeGrant(mission, id, { kind: 'permission', once: ['Allow once'], always: ['Always allow in this mission'] });
  if (grant.allowed) return { allowed: true, note: `allowed ${grant.reason === 'always' ? 'always' : 'once'} by the user (question ${id})` };
  if (grant.reason === 'used' || grant.reason === 'refused') return { allowed: false, question: id, answered: true };
  const questions = listQuestions(mission);
  const exists = questions.some((question) => question.id === id);
  const open = questions.filter((question) => question.kind === 'permission' && question.state === 'open').length;
  if (!exists && open >= MAX_OPEN_PERMISSION_QUESTIONS) {
    return { allowed: false, note: `${reason}; no question asked: ${open} permission questions already open` };
  }
  const context = `Tool ${input.tool_name || 'unknown'}, session ${input.session_id || 'unknown'}, in ${input.cwd || 'unknown'}: ${reason}`;
  const options = ['Allow once', 'Always allow in this mission', 'Refuse'];
  askQuestion(mission, { key, kind: 'permission', text, context, options, recommended: 3 });
  return { allowed: false, question: id };
}

const { mission, guard } = loadMissionGuard();
const input = readHookInput();
const reason = refusal(input, [...guard.allow, ...profileTools()]);
let answer = { allowed: false };
if (reason && input && input.tool_name && reason !== 'guard error') {
  try {
    answer = askUser(mission, input, reason);
  } catch {
    // A question that cannot be written: denied as it is.
  }
}
const allowed = !reason || answer.allowed;
const decision = allowed ? { behavior: 'allow' } : { behavior: 'deny', message: denyMessage(reason, answer.question, answer.answered) };
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }) + '\n');
if (answer.note) writeJournal(mission, input.tool_name, answer.note);
else if (reason) writeJournal(mission, input && input.tool_name, reason);
