// What the user's answer to a permission question allows (questions irr-<hash> and perm-<hash>).
// Only a question asked by the hooks counts: its stored kind must be the one expected.
// An answer in `always` allows the action every time; one in `once` allows it a single time:
// questions/<id>.used.json, written only by the hooks, says that time is used. Any other answer,
// or none yet, allows nothing.
const { readJson, writeJsonExclusive } = require('./store');
const { questionFile, answerFile, usedFile } = require('./questions');

// {allowed, reason}: reason is 'always', 'once', 'used', 'refused' or 'no answer'.
function consumeGrant(mission, id, { kind, once = [], always = [] }) {
  const question = readJson(questionFile(mission, id), null);
  if (!question || question.kind !== kind) return { allowed: false, reason: 'no answer' };
  const answer = readJson(answerFile(mission, id), null);
  if (!answer) return { allowed: false, reason: 'no answer' };
  if (always.includes(answer.choice)) return { allowed: true, reason: 'always' };
  if (!once.includes(answer.choice)) return { allowed: false, reason: 'refused' };
  // Written only if it does not exist yet: two calls at once cannot both use the same answer.
  const first = writeJsonExclusive(usedFile(mission, id), { usedAt: new Date().toISOString() });
  return first ? { allowed: true, reason: 'once' } : { allowed: false, reason: 'used' };
}

module.exports = { consumeGrant };
