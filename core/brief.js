// `relaylead brief`: what the console shows when a conversation opens, as one short text. It reads
// nothing itself: the problems come from doctor, the news from the catch-up of `wait --all
// --timeout 0` (so the next wait does not give them again), the questions and missions from the
// overview of the displays. `wait --all` prints its events with the same lines.
const doctorCheck = require('./doctor');
const { waitForEvents } = require('./console-wait');
const { buildOverview } = require('./overview');
const { localTime } = require('./usage-pause');
const { t } = require('./messages');
const { readMission, awaitsMerge } = require('./missions');

// A question as it is, with its mission and id: text, context, then the options numbered from 1,
// the recommended one marked. `isNew`: it was opened since the last look of the console.
function questionText(mission, question, isNew, lang) {
  const mark = isNew ? ` (${t('briefNewMark', {}, lang)})` : '';
  let text = `[${mission}] ${question.id}${mark}: ${question.text}\n`;
  if (question.context) text += question.context.replace(/^/gm, '  ') + '\n';
  question.options.forEach((option, index) => {
    const recommended = question.recommended === index + 1 ? t('briefRecommended', {}, lang) : '';
    text += `  ${index + 1}. ${option}${recommended}\n`;
  });
  return text;
}

function mergeable(name) {
  try {
    return awaitsMerge(readMission(name));
  } catch {
    return false; // the mission was removed since
  }
}

// An event of console-wait that is not a question: a task failed, a mission over, a merge done.
function eventText(event, lang) {
  if (event.kind === 'task') {
    return t('eventTaskFailed', { mission: event.mission, id: event.id, attempt: event.attempt, summary: event.summary || '-' }, lang);
  }
  if (event.kind === 'merge') return t('eventMerged', { mission: event.mission, target: event.target }, lang);
  // A done mission says what to run next: its work is still to be merged.
  // Only when the mission can be merged now (not a delivery of files, not still stopping, not removed).
  if (/^done/.test(event.state) && mergeable(event.mission)) return t('eventMissionDone', { mission: event.mission }, lang);
  return t('eventMission', { mission: event.mission, state: event.state }, lang);
}

// The output of `wait --all`: the events, the questions in full.
function eventsText(events, lang) {
  if (events.length === 0) return t('briefNothingNew', {}, lang);
  return events
    .map((event) => (event.kind === 'question' ? questionText(event.mission, { id: event.id, ...event.question }, true, lang) : eventText(event, lang)))
    .join('');
}

// One line for a mission not over: its state, its tasks delivered, then what else there is to say.
function missionLine(mission, lang) {
  const counts = {};
  for (const task of mission.tasks) counts[task.state] = (counts[task.state] || 0) + 1;
  let tasks = t('briefTasks', { delivered: counts.delivered || 0, total: mission.tasks.length }, lang);
  // Queued tasks are said once, below, as waiting for a place.
  const others = Object.keys(counts).filter((state) => !['todo', 'delivered', 'queued'].includes(state));
  if (others.length > 0) tasks += ` (${others.map((state) => `${counts[state]} ${state}`).join(', ')})`;
  const parts = [mission.state, tasks];
  if (mission.queued > 0) parts.push(t('briefQueued', { n: mission.queued }, lang));
  if (mission.pausedUntil) parts.push(t('briefPaused', { at: localTime(mission.pausedUntil) }, lang));
  if (mission.priority !== 'normal') parts.push(t('briefPriority', { priority: mission.priority }, lang));
  return `  ${mission.name}: ${parts.join(' · ')}\n`;
}

// The text of brief from what doctor, the catch-up and the overview gave.
function briefText({ problems, events, overview }, lang) {
  let text = '';
  if (problems.length > 0) {
    text += t('briefInstall', {}, lang) + problems.map((line) => `  ${line.level} ${line.name}: ${line.detail}\n`).join('');
  }
  const news = events.filter((event) => event.kind !== 'question');
  const fresh = new Set(events.filter((event) => event.kind === 'question').map((event) => `${event.mission} ${event.id}`));
  // "Nothing new" is said only when no question is new either: a new question is news.
  if (news.length > 0) text += t('briefNew', {}, lang) + news.map((event) => '  ' + eventText(event, lang)).join('');
  else if (fresh.size === 0) text += t('briefNothingNew', {}, lang);
  const questions = overview.missions.flatMap((mission) =>
    mission.questions.map((question) => questionText(mission.name, question, fresh.has(`${mission.name} ${question.id}`), lang)),
  );
  text += questions.length > 0 ? t('briefQuestions', { n: questions.length }, lang) + questions.join('') : t('briefNoQuestion', {}, lang);
  const running = overview.missions.filter((mission) => mission.active);
  text += running.length > 0 ? t('briefMissions', {}, lang) + running.map((mission) => missionLine(mission, lang)).join('') : t('briefNoMission', {}, lang);
  const toMerge = overview.missions.filter((mission) => mission.toMerge);
  if (toMerge.length > 0) text += t('briefToMerge', {}, lang) + toMerge.map((mission) => t('briefToMergeLine', { mission: mission.name }, lang)).join('');
  return text;
}

// Writes the brief with `write`. As for `wait --all`, the snapshot of the console is saved only once
// the text is written, so no news is lost on the way out. `dir`: the folder of the command (doctor
// checks its project memory). doctor is read from its module, so a test can replace it.
// The overview is read just after the catch-up: a question opened in between is shown, not marked
// new, and given again by the next wait (shown twice rather than missed). A mission the overview
// cannot read is left out of the text, though the catch-up has counted it as seen.
async function brief(dir, lang, write) {
  const problems = (await doctorCheck.doctor(dir, lang)).filter((line) => line.level !== 'ok');
  await waitForEvents(0, (events) => write(briefText({ problems, events, overview: buildOverview() }, lang)));
}

module.exports = { brief, eventsText };
