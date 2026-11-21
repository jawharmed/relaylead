// Questions to the human, asked by the lead or by the hooks (a permission, an irreversible action).
// questions/<id>.json is written once, when the question is asked; questions/<id>.answer.json is
// written only by answerQuestion; questions/<id>.used.json only by the hooks, once a one-time
// permission is used (core/grants.js).
const path = require('node:path');
const fs = require('node:fs');
const { missionDir, slug } = require('./paths');
const { writeJsonExclusive, readJson } = require('./store');
const { codedError } = require('./messages');
const { notify } = require('./notify');

function questionsDir(mission) {
  return path.join(missionDir(mission), 'questions');
}

function questionFile(mission, id) {
  return path.join(questionsDir(mission), `${id}.json`);
}

function answerFile(mission, id) {
  return path.join(questionsDir(mission), `${id}.answer.json`);
}

function usedFile(mission, id) {
  return path.join(questionsDir(mission), `${id}.used.json`);
}

// The recommended option goes first, so the numbers a person sees are the numbers `answer` takes.
function recommendedFirst(options, recommended) {
  if (recommended === undefined || recommended === null) return { options, recommended: null };
  if (!Number.isInteger(recommended) || recommended < 1 || recommended > options.length) {
    throw codedError('bad-question', { detail: `--recommended must be between 1 and ${options.length}` });
  }
  const chosen = options[recommended - 1];
  return { options: [chosen, ...options.filter((_, i) => i !== recommended - 1)], recommended: 1 };
}

// Asking again with the same key gives the existing question, open or answered: a settled question is never re-asked.
// `kind` is 'permission' or 'irreversible' for the questions of the hooks, null for the lead's.
function askQuestion(mission, { key, text, context, options, recommended, kind }) {
  if (!key || !text) throw codedError('bad-question', { detail: 'a key and a text are needed' });
  if (!Array.isArray(options) || options.length < 2) {
    throw codedError('bad-question', { detail: 'give at least two --option' });
  }
  let id;
  try {
    id = `q-${slug(key)}`;
  } catch {
    throw codedError('bad-question', { detail: 'the key needs at least one letter or digit' });
  }
  const question = {
    id,
    key,
    text,
    context: context || null,
    kind: kind || null,
    ...recommendedFirst(options, recommended),
    state: 'open',
    askedAt: new Date().toISOString(),
  };
  const created = writeJsonExclusive(questionFile(mission, id), question);
  if (created) {
    notify({ title: `Relaylead: ${mission}`, text: `Question ${id}: ${text}` });
    return { id, existing: false };
  }
  // Different keys can make the same id (A.b and a-b): the existing question is not the one asked.
  const stored = readJson(questionFile(mission, id));
  if (stored.key !== key) throw codedError('question-key-clash', { key, id, storedKey: stored.key });
  return { id, existing: true };
}

function withAnswer(mission, question) {
  const answer = readJson(answerFile(mission, question.id), null);
  return answer ? { ...question, state: 'answered', answer } : question;
}

// All the questions, or only those in `state` ('open' or 'answered').
function listQuestions(mission, { state } = {}) {
  let files = [];
  try {
    files = fs.readdirSync(questionsDir(mission));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return files
    .filter((file) => file.endsWith('.json') && !file.endsWith('.answer.json') && !file.endsWith('.used.json'))
    .sort()
    .map((file) => withAnswer(mission, readJson(path.join(questionsDir(mission), file))))
    .filter((question) => !state || question.state === state);
}

// `choice` is an option number (1-based) or an option text; it is stored as the text.
function answerQuestion(mission, id, choice) {
  const question = readJson(questionFile(mission, id), null);
  if (!question) throw codedError('question-unknown', { mission, id });
  const text = String(choice).trim();
  const byNumber = /^\d+$/.test(text) ? question.options[Number(text) - 1] : undefined;
  const byText = question.options.find((option) => option.toLowerCase() === text.toLowerCase());
  const chosen = byNumber || byText;
  if (!chosen) throw codedError('bad-choice', { choice: text, options: question.options.join(', ') });
  const written = writeJsonExclusive(answerFile(mission, id), { choice: chosen, answeredAt: new Date().toISOString() });
  if (!written) {
    const previous = readJson(answerFile(mission, id));
    throw codedError('question-answered', { id, choice: previous.choice });
  }
  return chosen;
}

module.exports = { askQuestion, answerQuestion, listQuestions, questionFile, answerFile, usedFile };
