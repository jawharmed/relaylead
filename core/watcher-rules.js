// The watcher's rules ("Règles du veilleur" in the plan of lot 2a): what to do with a mission, from one
// observation of it. Pure: nothing is read here, the time comes from obs.now (ms). The actions are
// carried out by watcher.js (act), under the mission lock.
//
// obs: {now, mission, record (state.json), lead (lead.json), rows (the adapter's list, null when it
// failed), listError, tasksError, leadIdleConfirmed, registry, tasks (null when they could not be
// read), readings: {[shortId]: {heartbeat, statusline, failure}}, failures (the whole failures/
// folder, by short id), unseen (what the next `relaylead wait` would report, wait.js unseenChanges:
// {changes, viewKey, toFail, lostSince}, null without the list or the tasks), mail (unread messages
// by short id), usage (the account's usage, usage.js readUsage: null when stale or missing), pause
// (usage-pause.json, null when the mission is not paused), config, watch (watch.json)}.
//
// obs.questions: the open questions (questions.js listQuestions), null when they could not be read.
// obs.lastActivityAt: when a file of the mission folder last changed, in ms (abandon.js lastActivity).
//
// Actions: {type: 'stop-session', session, log}, {type: 'log', text, journal}, {type: 'mark-failed',
// id, summary, log}, {type: 'wake-lead', reasons, log}, {type: 'relaunch-lead', resume} and
// {type: 'trip-breaker', afterLock: true, note} (note: why, when it is not the failed relaunches),
// {type: 'hand-over', reason: 'asked'|'forced'|'idle', note,
// tokens}, {type: 'mail', shortId, text, log}, {type: 'answer-question', id, choice, log} (answers it
// as the user would, and writes `log` to both logs), {type: 'remind-question', id, text, log} (a
// notification to the user), {type: 'pause-mission', resumeAt, reason, wake, log} and
// {type: 'resume-mission', log}; {type: 'notify', text, log} (a notification to the user).
const { contextOf } = require('./readings');
const { DEFAULTS, deepMerge } = require('./config');
const { isFresh } = require('./usage');
const { abandonDays, isSilent } = require('./abandon');

// An active lead whose last heartbeat is older than this is reported, never stopped.
const SILENT_MS = 30 * 60 * 1000;

// How long a lead working without a process, or missing from the list, may be restarting by itself
// (Claude's own service restarts a killed session in about 11 s, measured fact 4); also how recent a
// heartbeat keeps a lead missing from the list restarting. Read at each call: tests shorten it.
const restartGraceMs = () => Number(process.env.RELAYLEAD_RESTART_GRACE_MS) || 120000;

// The guard of the wakes ("Garde du réveil"). No wake this soon after an action on the lead (a wake, a
// relaunch, a handover); read at each call: tests shorten it.
const leadQuietMs = () => Number(process.env.RELAYLEAD_LEAD_QUIET_MS) || 10000;
// A wake that no heartbeat follows within this time had no effect.
const INEFFECTIVE_AFTER_MS = 5 * 60 * 1000;
// After 1, 2, then 3 wakes without effect, the next one waits this long; past 3, the lead is stuck.
const WAKE_BACKOFF_MS = [15, 30, 60].map((minutes) => minutes * 60 * 1000);
// After this many relaunches in a row that failed, the watcher stops the mission (the breaker).
const MAX_FAILED_RELAUNCHES = 3;
// A usage limit hit longer ago than this no longer pauses the mission; read at each call.
const rateLimitHoldMs = () => Number(process.env.RELAYLEAD_RATE_LIMIT_HOLD_MS) || 5 * 60 * 60 * 1000;
// How long a lead told to stop for the usage limit may take to push its work and end its turn, before
// the sessions of its mission are stopped; read at each call: tests shorten it.
const usagePauseGraceMs = () => Number(process.env.RELAYLEAD_USAGE_PAUSE_GRACE_MS) || 120000;
// A lead idle while the mission works, silent this long, has ended its turn (a command lasts 10 min
// at most).
const INTERRUPT_SILENCE_MS = 11 * 60 * 1000;
// Rule 30: a question left open is recalled to the user at most this often.
const QUESTION_REMIND_MS = 6 * 60 * 60 * 1000;
// Session failures that no wake or relaunch can fix: the user must act (credit, key, login). The note
// the mission is stopped with, by the breaker.
const BLOCKING_FAILURES = {
  billing_error: 'stopped by the watcher: billing error (the API credit is used up, or billing failed); fix it, then launch again',
  authentication_failed: 'stopped by the watcher: authentication failed (check the API key or the Claude login); fix it, then launch again',
};

// watch.json, the watcher's memory of a mission. A missing field has this value.
function emptyWatch() {
  return {
    leadLostSince: null,
    crewLostSince: {},
    failedRelaunches: 0,
    lastRelaunchAt: null,
    lastFailedRelaunchAt: null,
    lastLeadActionAt: null,
    lastWakeAt: null,
    lastWakeView: null,
    ineffectiveWakes: 0,
    lastIneffectiveAt: null,
    stuckNoticeFor: null,
    interruptWakeFor: null,
    unlistedNoticeFor: null,
    handoverNoticeFor: null,
    contextFullNotices: [],
    baseAlerts: [],
    silentNoticeFor: null,
    failuresSeen: {},
    tripped: false,
    breakerNote: null,
    notifiedQuestions: {},
    usageTries: 0,
    usagePausedFor: null,
    abandonedNoticeFor: null,
  };
}

function iso(ms) {
  return new Date(ms).toISOString();
}

// The row of the current lead (lead.json's short id), or null when the list does not show it.
function leadRow(obs) {
  return (obs.rows || []).find((row) => row.shortId === obs.lead.shortId) || null;
}

// When the current lead last beat: its heartbeat, or its start when it never beat.
function lastBeat(obs) {
  const readings = obs.readings[obs.lead.shortId] || {};
  return (readings.heartbeat && readings.heartbeat.at) || obs.lead.startedAt;
}

// Milliseconds since then; an unreadable date is as old as can be.
function heartbeatAge(obs) {
  const at = Date.parse(lastBeat(obs));
  return Number.isFinite(at) ? obs.now - at : Infinity;
}

// Working without a process, or not listed: the agent knows no process for the lead, which may be
// restarting.
function isLost(row) {
  return !row || (row.state === 'working' && !row.pid);
}

// The lead as the rules see it: 'active', 'idle', 'restarting' or 'absent' ("États du lead"). For an
// observation whose list succeeded. A lead absent while the mission waits counts as idle: it is not
// relaunched, and a wake works on a stopped session.
function leadStatus(obs) {
  const status = statusOfRow(obs, leadRow(obs));
  return status === 'absent' && obs.record.state === 'waiting' ? 'idle' : status;
}

function statusOfRow(obs, row) {
  if (row && row.pid) {
    // One idle read may be the start of a turn (measured fact 2): idle on two reads only.
    if (row.state === 'working') return row.idle === true && obs.leadIdleConfirmed ? 'idle' : 'active';
    if (row.state === 'waiting' || row.state === 'done') return 'idle';
    return 'absent'; // stopped or failed
  }
  if (!isLost(row)) return 'absent'; // stopped, failed, or waiting or done without a process
  if (lostFor(obs) < restartGraceMs()) return 'restarting';
  if (!row && heartbeatAge(obs) < restartGraceMs()) return 'restarting';
  return 'absent';
}

// Since when the lead is lost: 0 at the first observation that sees it lost.
function lostFor(obs) {
  const since = Date.parse(obs.watch.leadLostSince);
  return Number.isFinite(since) ? obs.now - since : 0;
}

// The rules of the plan ("Table des règles"). Returns {actions, watch, again}: watch is a new object, obs is left as
// it is. `again` asks a patient pass (a targeted one) to look again soon: the lead is active with
// something to wake it for once its turn ends, or a wake is held back by the quiet time, or by a crew
// failed in this pass.
function decide(obs) {
  const watch = { ...emptyWatch(), ...JSON.parse(JSON.stringify(obs.watch || {})) };
  const actions = [];
  const result = { actions, watch, again: false };
  const log = (text, journal = false) => actions.push({ type: 'log', text, journal });
  // Rule 1: a tripped mission, its stop not done yet: its stop is replayed, and nothing else is done.
  if (watch.tripped) {
    actions.push(breakerAction(watch));
    return result;
  }
  if (obs.record.stopping) return result;

  // Rule 4b: a billing or authentication failure of any session stops the mission at once: waking or
  // relaunching would fail the same way, and the user must act.
  const blocking = logFailures(obs, watch, log).find((failure) => BLOCKING_FAILURES[failure.error]);
  if (blocking) {
    watch.tripped = true;
    watch.breakerNote = BLOCKING_FAILURES[blocking.error];
    log(`breaker-tripped ${blocking.error} ${blocking.shortId}`, true);
    actions.push(breakerAction(watch));
    return result;
  }
  // Without the list, nothing is known of the sessions.
  if (obs.listError) {
    log(`list-failed ${obs.listError}`);
    return result;
  }
  if (obs.tasksError) log(`tasks-failed ${obs.tasksError}`);
  // Rules 20 and 21: a mission paused for the usage limits is tended by them alone, but for its
  // questions (rule 30), which start no session.
  if (tendUsage(obs, watch, actions, log)) {
    tendQuestions(obs, watch, actions);
    tendAbandoned(obs, watch, actions);
    return result;
  }
  stopExtraLeads(obs, actions);
  if (obs.tasks) stopOrphanCrew(obs, actions);
  const status = leadStatus(obs);
  // Without the tasks, nothing is known of what the lead has not seen: rules 5 and 14 wait.
  const unseen = obs.tasks ? obs.unseen : null;
  if (unseen) {
    watch.crewLostSince = unseen.lostSince;
    if (unseen.changes.length === 0) watch.lastWakeView = null;
    if (status !== 'active') failLostCrew(unseen, actions);
  }
  watchLead(obs, watch, log);
  judgeWakes(obs, watch);
  judgeRelaunches(obs, watch);
  if (obs.tasks) notifyFullCrew(obs, watch, actions); // rule 19
  // Rules 8 to 16: one action on the lead at most; 17 and 18 only when none of them acted.
  const before = actions.length;
  if (status === 'absent') tendAbsentLead(obs, watch, actions, log);
  else if (status !== 'restarting' && handoverAsked(obs)) handOver(actions, 'asked', obs.record.note);
  else if (status === 'idle') result.again = tendIdleLead(obs, watch, unseen, actions, log);
  else if (status === 'active') {
    const context = leadContext(obs, true);
    if (context && context.tokens >= context.hard) handOver(actions, 'forced', null, context.tokens); // rule 12
    else result.again = Boolean(unseen && unseen.changes.length > 0) || (obs.mail || {})[obs.lead.shortId] > 0;
  }
  if (actions.slice(before).every((action) => action.type === 'log')) adviseLead(obs, watch, status, actions, log);
  tendQuestions(obs, watch, actions); // rule 30
  tendAbandoned(obs, watch, actions); // rule 31
  return result;
}

// The lead's context and its thresholds (readings.js), or null; `active`: a stale reading says nothing.
function leadContext(obs, active) {
  return contextOf(obs.readings[obs.lead.shortId] || {}, { role: 'lead', config: obs.config, now: obs.now, active });
}

// Rule 9: a handover asked by the current lead, or by the user. One asked by a replaced lead is not.
function handoverAsked(obs) {
  return obs.record.state === 'handover' && [obs.lead.sessionName, 'user'].includes(obs.record.by);
}

function handOver(actions, reason, note = null, tokens = null) {
  actions.push({ type: 'hand-over', reason, note, tokens });
}

// Rules 17 and 18: an active lead past its soft threshold, on a fresh reading, is told once to hand
// over; a base past half the soft threshold is logged once.
function adviseLead(obs, watch, status, actions, log) {
  const shortId = obs.lead.shortId;
  const context = leadContext(obs, status === 'active');
  if (!context) return;
  if (status === 'active' && context.tokens >= context.soft && watch.handoverNoticeFor !== shortId) {
    watch.handoverNoticeFor = shortId;
    actions.push({
      type: 'mail',
      shortId,
      text: `Your context holds ${context.tokens} tokens, past the handover threshold of ${context.soft}. Finish the step you are on, then run \`relaylead state set handover --note "<where the mission stands, in one line>"\` and end your turn: a fresh lead takes over from the files.`,
      log: `notify-handover ${shortId} ${context.tokens}/${context.soft}`,
    });
  }
  if (context.baseTokens > context.soft / 2 && !watch.baseAlerts.includes(shortId)) {
    watch.baseAlerts.push(shortId);
    log(`base-high ${shortId} ${context.baseTokens}/${context.soft}`);
  }
}

// Rule 19: a crew member listed with a process, its task running, its window measured, past its hard
// threshold: told once to commit and fail its task.
function notifyFullCrew(obs, watch, actions) {
  for (const session of obs.registry) {
    if (session.role !== 'crew' || !hasProcess(obs, session) || watch.contextFullNotices.includes(session.shortId)) continue;
    const task = obs.tasks.find((candidate) => candidate.session === session.shortId && candidate.state === 'running');
    if (!task) continue;
    const context = contextOf(obs.readings[session.shortId] || {}, { role: 'crew', config: obs.config, now: obs.now, active: false });
    if (!context || !context.windowTokens || context.tokens < context.hard) continue;
    watch.contextFullNotices.push(session.shortId);
    actions.push({
      type: 'mail',
      shortId: session.shortId,
      text: `Your context holds ${context.tokens} tokens and is full. Commit what you have done on your branch, then run \`relaylead task fail ${task.id} --summary "context full: <what is done, what remains>"\` and end your turn: the lead starts a fresh session on your branch.`,
      log: `notify-context-full ${session.shortId} task ${task.id}`,
    });
  }
}

// Rule 5: a crew lost past the grace of wait, while the lead is not active (an active lead's own wait
// fails its task). The task is failed by act; the lead is woken for it at the next pass.
function failLostCrew(unseen, actions) {
  for (const { id, shortId, summary } of unseen.toFail) {
    actions.push({ type: 'mark-failed', id, summary, log: `crew-lost ${shortId || '-'} task ${id}` });
  }
}

function hasProcess(obs, session) {
  return (obs.rows || []).some((row) => row.shortId === session.shortId && Boolean(row.pid));
}

// Rule 2: a lead session of the registry other than the current one, listed with a process.
function stopExtraLeads(obs, actions) {
  for (const session of obs.registry) {
    if (session.role !== 'lead' || session.shortId === obs.lead.shortId || !hasProcess(obs, session)) continue;
    actions.push({ type: 'stop-session', session, log: `stop-extra-lead ${session.shortId}` });
  }
}

// Rule 3: a crew session listed with a process whose task no longer runs it: its task is finished
// or delivered, or no task names it any more (retried on another session, or none ever did).
function stopOrphanCrew(obs, actions) {
  for (const session of obs.registry) {
    if (session.role !== 'crew' || !hasProcess(obs, session)) continue;
    const task = obs.tasks.find((candidate) => candidate.session === session.shortId);
    if (task && task.state === 'running') continue;
    actions.push({ type: 'stop-session', session, log: `stop-orphan-crew ${session.shortId} task ${task ? task.id : '-'}` });
  }
}

// The stop of the breaker, with its note when it is not that of the failed relaunches.
function breakerAction(watch) {
  return watch.breakerNote ? { type: 'trip-breaker', afterLock: true, note: watch.breakerNote } : { type: 'trip-breaker', afterLock: true };
}

// Rule 4: each failure newer than the last one seen of that session, registered or not. Returns
// them, each with its shortId.
function logFailures(obs, watch, log) {
  const fresh = [];
  for (const [shortId, failure] of Object.entries(obs.failures || {})) {
    const at = Date.parse(failure.at);
    const seen = Date.parse(watch.failuresSeen[shortId]);
    if (!Number.isFinite(at) || (Number.isFinite(seen) && at <= seen)) continue;
    watch.failuresSeen[shortId] = failure.at;
    const message = String(failure.message || '-').replace(/\s+/g, ' ').trim();
    log(`session-failure ${shortId} ${failure.error || '-'}: ${message}`);
    fresh.push({ ...failure, shortId });
  }
  return fresh;
}

// Rules 6 and 7, and the time the lead was first seen lost. The time is cleared as soon as the lead
// is seen again in any state that is not lost (a whole grace at each loss), even without a process:
// a lead listed stopped would otherwise keep the date of an older loss, and be absent at once at its
// next one. A lead still missing from the list keeps it: that is what keeps the absent lead of a
// waiting mission idle, instead of going back and forth between restarting and idle.
function watchLead(obs, watch, log) {
  const row = leadRow(obs);
  const status = leadStatus(obs);
  const shortId = obs.lead.shortId;
  if (!isLost(row)) {
    watch.leadLostSince = null;
  } else {
    if (!watch.leadLostSince) {
      if (status === 'restarting') log(`lead-restarting ${shortId}`); // rule 6
      watch.leadLostSince = iso(obs.now);
    } else if (status === 'restarting' && !row && lostFor(obs) >= restartGraceMs() && watch.unlistedNoticeFor !== shortId) {
      // Past the grace, only its heartbeat keeps it restarting.
      log(`lead-unlisted-but-alive ${shortId}`);
      watch.unlistedNoticeFor = shortId;
    }
  }
  // Rule 7: once per silence, that is per last heartbeat.
  const silence = `${shortId} ${lastBeat(obs)}`;
  if (status === 'active' && heartbeatAge(obs) > SILENT_MS && watch.silentNoticeFor !== silence) {
    log(`lead-silent ${shortId} ${Math.floor(heartbeatAge(obs) / 60000)} min`, true);
    watch.silentNoticeFor = silence;
  }
}

// The lead's last heartbeat, in ms; NaN when it never beat.
function heartbeatMs(obs) {
  const readings = obs.readings[obs.lead.shortId] || {};
  return Date.parse(readings.heartbeat && readings.heartbeat.at);
}

// What a wake without effect does to watch.json: counted, and its motive due again. Also applied by
// act to a wake that throws. `now` in ms.
function wakeWithoutEffect(watch, now) {
  return {
    ineffectiveWakes: watch.ineffectiveWakes + 1,
    lastIneffectiveAt: iso(now),
    lastWakeAt: null,
    lastWakeView: null,
    interruptWakeFor: null,
  };
}

// The guard's memory, whatever the lead's state: any heartbeat after the last wake, or after the last
// wake judged without effect, sets the count back to 0 (a lead unblocked by hand is woken again). A
// wake followed by a heartbeat worked: lastWakeAt is cleared, so it is never judged again. A wake had
// no effect when no heartbeat has followed it for 5 min, or when the lead failed after it (failures/:
// a usage limit, an API error), after its last heartbeat and before any wake judged since: the turn
// it started died before the lead could see what woke it (once a pause for the usage limit is over, rules 20 and 21, the
// motive is due again). The time of that wake is lastLeadActionAt, which lastWakeAt clears not.
function judgeWakes(obs, watch) {
  const beat = heartbeatMs(obs);
  if (beat > Date.parse(watch.lastWakeAt) || beat > Date.parse(watch.lastIneffectiveAt)) {
    watch.ineffectiveWakes = 0;
    watch.stuckNoticeFor = null;
  }
  const wakeAt = Date.parse(watch.lastWakeAt);
  if (beat > wakeAt) watch.lastWakeAt = null;
  const failure = (obs.readings[obs.lead.shortId] || {}).failure;
  const failedAt = Date.parse(failure && failure.at);
  const failedAfterWake =
    failedAt > Date.parse(watch.lastLeadActionAt) && !(beat >= failedAt) && !(Date.parse(watch.lastIneffectiveAt) >= failedAt);
  const unanswered = Number.isFinite(Date.parse(watch.lastWakeAt)) && obs.now - wakeAt >= INEFFECTIVE_AFTER_MS;
  if (failedAfterWake || unanswered) Object.assign(watch, wakeWithoutEffect(watch, obs.now));
}

// The count of the breaker ("Décompte du disjoncteur"): any heartbeat of the current lead after the
// last relaunch, or after the last failed one, sets it back to 0.
function judgeRelaunches(obs, watch) {
  const beat = heartbeatMs(obs);
  if (beat > Date.parse(watch.lastRelaunchAt) || beat > Date.parse(watch.lastFailedRelaunchAt)) {
    watch.failedRelaunches = 0;
    watch.lastRelaunchAt = null;
    watch.lastFailedRelaunchAt = null;
  }
}

// Rules 8 and 10, for an absent lead. A relaunch that no heartbeat has followed failed: it counts.
// Past 3 in a row, the breaker trips (the mission is stopped after the lock); otherwise the lead is
// relaunched, resumed when its context is known and under the soft threshold.
function tendAbsentLead(obs, watch, actions, log) {
  const asked = handoverAsked(obs);
  if (!asked && Number.isFinite(Date.parse(watch.lastRelaunchAt))) {
    watch.failedRelaunches += 1;
    watch.lastFailedRelaunchAt = iso(obs.now);
    watch.lastRelaunchAt = null;
  }
  if (watch.failedRelaunches >= MAX_FAILED_RELAUNCHES) {
    watch.tripped = true;
    log(`breaker-tripped after ${MAX_FAILED_RELAUNCHES} failed relaunches`, true);
    actions.push({ type: 'trip-breaker', afterLock: true });
    return;
  }
  if (asked) return handOver(actions, 'asked', obs.record.note); // rule 9
  const context = leadContext(obs, false);
  actions.push({ type: 'relaunch-lead', resume: Boolean(context) && context.tokens < context.soft });
}

// Rules 14 to 16, for an idle lead: one wake at most, for every motive there is. True when a
// wake is held back only for a moment (quiet time, a crew failed by this pass): a patient pass looks
// again.
function tendIdleLead(obs, watch, unseen, actions, log) {
  const motives = wakeMotives(obs, watch, unseen);
  if (motives.length === 0) return false;
  // A crew being failed by this pass: the lead is woken once its task is failed, at the next pass.
  if (unseen && unseen.toFail.length > 0) return true;
  if (obs.now - Date.parse(watch.lastLeadActionAt) < leadQuietMs()) return true;
  if (!wakeAllowed(obs, watch, log)) return false;
  // Rule 13: past its soft threshold, it is handed over instead of woken.
  const context = leadContext(obs, false);
  if (context && context.tokens >= context.soft) {
    handOver(actions, 'idle');
    return false;
  }
  watch.lastWakeAt = iso(obs.now);
  watch.lastLeadActionAt = iso(obs.now);
  for (const motive of motives) Object.assign(watch, motive.remember);
  actions.push({
    type: 'wake-lead',
    reasons: motives.flatMap((motive) => motive.reasons),
    log: `wake-lead ${obs.lead.shortId}: ${motives.map((motive) => motive.log).join('; ')}`,
  });
  return false;
}

// Rules 20 and 21, the usage limits of the account (lot 2b; they replace rule 11, which only held the
// wakes of a lead after a usage limit). True when they take the pass, while the mission pauses or is
// paused: no relaunch, no wake, no crew failed as lost, nothing counted for the breaker.
// Rule 20: past the threshold of its priority, or after a usage limit hit, the mission pauses. A lead
// that runs is woken once to push its work; otherwise, or after a usage limit hit (no turn can run),
// the sessions are stopped at once.
// Rule 21: paused, its sessions are stopped once the lead has ended its turn, or past the grace; once
// none runs, at the time to resume, and with the measured usage under the threshold (or unknown), the
// pause is lifted and the absent lead relaunched (rule 10).
function tendUsage(obs, watch, actions, log) {
  // The lead has worked since the usage limit of the last pause: the tries start again from 15 min.
  if (heartbeatMs(obs) > Date.parse(watch.usagePausedFor)) watch.usageTries = 0;
  if (!obs.pause) {
    const verdict = usageVerdict({ ...obs, watch });
    if (!verdict) return false;
    if (verdict.failureAt) {
      watch.usagePausedFor = verdict.failureAt;
      watch.usageTries += 1;
    }
    // A relaunch cut short by the usage limit did not fail.
    watch.lastRelaunchAt = null;
    const wake = !verdict.failureAt && hasProcess(obs, obs.lead);
    actions.push({
      type: 'pause-mission',
      resumeAt: verdict.resumeAt,
      reason: verdict.reason,
      wake,
      log: `usage-pause until ${iso(verdict.resumeAt)}: ${verdict.reason}`,
    });
    if (!wake) stopRunning(obs, actions);
    return true;
  }
  const running = obs.registry.filter((session) => hasProcess(obs, session));
  if (running.length > 0) {
    const waited = obs.now - Date.parse(obs.pause.at);
    if (!(leadStatus(obs) === 'active' && waited < usagePauseGraceMs())) stopRunning(obs, actions);
    return true;
  }
  if (!(obs.now >= Date.parse(obs.pause.resumeAt)) || measuredVerdict(obs)) return true;
  actions.push({ type: 'resume-mission', log: `usage-resumed ${obs.lead.shortId}` });
  watch.leadLostSince = null;
  tendAbsentLead(obs, watch, actions, log);
  return true;
}

// Every session of the mission that runs is stopped: the crew first, then the leads.
function stopRunning(obs, actions) {
  const running = obs.registry.filter((session) => hasProcess(obs, session));
  for (const session of [...running.filter((one) => one.role !== 'lead'), ...running.filter((one) => one.role === 'lead')]) {
    actions.push({ type: 'stop-session', session, log: `usage-stop ${session.shortId}` });
  }
}

// The motives of rules 14 to 16, in order: {reasons (for the wake's text), log, remember (what watch
// keeps of it once the lead is woken)}.
function wakeMotives(obs, watch, unseen) {
  const motives = [];
  // Rule 14: changes the lead has not seen, once per view.
  if (unseen && unseen.changes.length > 0 && unseen.viewKey !== watch.lastWakeView) {
    const reasons = unseen.changes.map((change) =>
      change.kind === 'message'
        ? `the user told you something (${change.id}): run \`relaylead wait --timeout 0\` to read it`
        : `${change.kind} ${change.id} is now ${change.to || 'gone'}`,
    );
    motives.push({ reasons, log: reasons.join('; '), remember: { lastWakeView: unseen.viewKey } });
  }
  // Rule 15: mail for the lead.
  if ((obs.mail || {})[obs.lead.shortId] > 0) motives.push({ reasons: ['you have mail'], log: 'mail', remember: {} });
  // Rule 16: its turn ended while the mission works, once per state (or per lead, before any state).
  const key = obs.record.updatedAt || obs.lead.startedAt;
  const readings = obs.readings[obs.lead.shortId] || {};
  const stopped = Boolean(readings.heartbeat) && readings.heartbeat.tool === '(stop)';
  if (
    hasProcess(obs, obs.lead) &&
    ['working', 'starting'].includes(obs.record.state) &&
    key !== watch.interruptWakeFor &&
    (stopped || heartbeatAge(obs) > INTERRUPT_SILENCE_MS)
  ) {
    const reasons = ['your turn ended while the mission was working'];
    motives.push({ reasons, log: 'turn ended while working', remember: { interruptWakeFor: key } });
  }
  return motives;
}

// The guard of a wake that has a motive: quiet time after an action on the lead, a wake not judged
// yet, then the backoff of the wakes without effect; past 3, `lead-stuck`, once, in both logs.
function wakeAllowed(obs, watch, log) {
  if (obs.now - Date.parse(watch.lastLeadActionAt) < leadQuietMs()) return false;
  // Not judged yet: no heartbeat since, no failure, and less than 5 min old (judgeWakes clears it).
  if (Number.isFinite(Date.parse(watch.lastWakeAt))) return false;
  const count = watch.ineffectiveWakes;
  if (count > WAKE_BACKOFF_MS.length) {
    if (watch.stuckNoticeFor !== obs.lead.shortId) {
      log(`lead-stuck ${obs.lead.shortId}`, true);
      watch.stuckNoticeFor = obs.lead.shortId;
    }
    return false;
  }
  return !(count > 0 && obs.now - Date.parse(watch.lastIneffectiveAt) < WAKE_BACKOFF_MS[count - 1]);
}

// The settings of questions.onTimeout: a wrong value is 'wait', a wrong delay 60 minutes. The delay
// is shortened by RELAYLEAD_QUESTION_TIMEOUT_MS in the tests; read at each call.
function questionSettings(config) {
  const settings = (config && config.questions) || {};
  const onTimeout = ['wait', 'recommended', 'skip'].includes(settings.onTimeout) ? settings.onTimeout : 'wait';
  const minutes = Number.isFinite(settings.timeoutMinutes) && settings.timeoutMinutes > 0 ? settings.timeoutMinutes : 60;
  return { onTimeout, timeoutMs: Number(process.env.RELAYLEAD_QUESTION_TIMEOUT_MS) || minutes * 60 * 1000 };
}

// Rule 30: each question open for longer than the delay. With 'recommended', its recommended option
// (always the first) is applied; with 'skip', its "Skip this task" option, or the recommended one.
// A question about a permission or an irreversible action is never answered for the user, nor is any
// question with 'wait': the user is reminded, at the end of the delay, then every 6 hours at most.
function tendQuestions(obs, watch, actions) {
  const { onTimeout, timeoutMs } = questionSettings(obs.config);
  for (const question of obs.questions || []) {
    if (!(obs.now - Date.parse(question.askedAt) >= timeoutMs)) continue;
    // Judged by the id too: a question q-irr-… or q-perm-… is never answered for the user, whatever its kind.
    const forTheUser = question.kind === 'permission' || question.kind === 'irreversible' || /^q-(irr|perm)-/.test(question.id);
    if (!forTheUser && onTimeout !== 'wait') {
      const skip = question.options.find((option) => option === 'Skip this task');
      const choice = onTimeout === 'skip' && skip ? skip : question.options[0];
      actions.push({ type: 'answer-question', id: question.id, choice, log: `question-timeout-applied ${question.id} ${choice}` });
      continue;
    }
    const remindedAt = Date.parse(watch.notifiedQuestions[question.id]);
    if (obs.now - remindedAt < QUESTION_REMIND_MS) continue;
    watch.notifiedQuestions[question.id] = iso(obs.now);
    const text = `Question ${question.id} waits for your answer: ${question.text}`;
    actions.push({ type: 'remind-question', id: question.id, text, log: `question-reminder ${question.id}` });
  }
}

// Rule 31: a mission that waits for the user (a question open) while nothing has changed in its folder
// for abandonDays days is abandoned: the user is told once per silence (a notification and the log).
// Nothing is stopped or removed. Its journal is not written: that would end the silence.
function tendAbandoned(obs, watch, actions) {
  const open = obs.questions || [];
  if (!isSilent(obs.config, open.length, obs.lastActivityAt, obs.now)) return;
  const silence = iso(obs.lastActivityAt);
  if (watch.abandonedNoticeFor === silence) return;
  watch.abandonedNoticeFor = silence;
  const days = abandonDays(obs.config);
  actions.push({
    type: 'notify',
    text: `Mission ${obs.mission.name} looks abandoned: question ${open[0].id} is open and nothing has moved for ${days} days. Answer it, or stop the mission.`,
    log: `mission-abandoned ${open[0].id} ${days} days`,
  });
}

// The usage settings of a mission: its configuration over the defaults.
function usageSettings(config) {
  return deepMerge(DEFAULTS.usage, (config && config.usage) || {});
}

// The thresholds of the mission's priority ('normal' for an unknown one).
function thresholdsOf(obs) {
  const { thresholds } = usageSettings(obs.config);
  return thresholds[obs.mission.priority] || thresholds.normal;
}

// The wait before the next try, in ms, after `tries` pauses whose time to resume was not known: 15,
// 30, then 60 min by default, the last one again past them.
function retryMs(config, tries) {
  const minutes = usageSettings(config).retryMinutes;
  return minutes[Math.min(tries, minutes.length - 1)] * 60 * 1000;
}

// The time a usage limit resets at, from the message of the failure ("You've hit your 5-hour limit ·
// resets 2:54am (Europe/Paris)"), in ms; null when the message does not say. The hour is read in the
// machine's time zone (the zone in brackets is ignored): the next time it comes after `since` (ms),
// the time of the failure, so the next day when it has passed.
function parseResetTime(message, since) {
  const found = /resets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(String(message || ''));
  if (!found || !(found[2] || found[3])) return null;
  let hour = Number(found[1]);
  const minute = Number(found[2] || 0);
  const half = (found[3] || '').toLowerCase();
  if (half && (hour < 1 || hour > 12)) return null;
  if (half === 'am' && hour === 12) hour = 0;
  if (half === 'pm' && hour < 12) hour += 12;
  if (hour > 23 || minute > 59) return null;
  const reset = new Date(since);
  reset.setHours(hour, minute, 0, 0);
  if (reset.getTime() <= since) reset.setDate(reset.getDate() + 1);
  return reset.getTime();
}

// Whether the mission must pause for the usage of the account, and until when: null, or {resumeAt
// (ms), reason, failureAt (the failure it comes from, null for a measured usage)}. The usage measured
// by the status line first, then a usage limit hit by a session.
function usageVerdict(obs) {
  return measuredVerdict(obs) || failureVerdict(obs);
}

// A fresh usage past the threshold of the mission's priority, for the 5-hour or the 7-day window: the
// mission resumes once the window past its threshold resets (the later one when both are).
function measuredVerdict(obs) {
  const usage = obs.usage;
  if (!isFresh(usage, obs.now)) return null;
  const limits = thresholdsOf(obs);
  const over = [
    { window: usage.fiveHour, name: 'five-hour', limit: limits.fiveHour },
    { window: usage.sevenDay, name: 'week', limit: limits.week },
  ].filter((one) => one.window && one.window.percent >= one.limit);
  if (over.length === 0) return null;
  const resumeAt = Math.max(...over.map((one) => Date.parse(one.window.resetsAt) || obs.now + retryMs(obs.config, 0)));
  const reason = over.map((one) => `${one.name} ${one.window.percent}% >= ${one.limit}%`).join(', ');
  return { resumeAt, reason, failureAt: null };
}

// The last usage limit hit by the lead or a crew member, after its own last heartbeat, less than 5 h
// ago, and newer than the one the last pause came from. It resumes at the time its message gives,
// otherwise after the wait of watch.usageTries tries (15, 30, 60 min).
function failureVerdict(obs) {
  const watch = obs.watch || {};
  let last = null;
  for (const [shortId, readings] of Object.entries(obs.readings || {})) {
    const failure = readings && readings.failure;
    if (!failure || failure.error !== 'rate_limit') continue;
    const at = Date.parse(failure.at);
    const beat = shortId === obs.lead.shortId ? Date.parse(lastBeat(obs)) : Date.parse(readings.heartbeat && readings.heartbeat.at);
    if (!(obs.now - at < rateLimitHoldMs()) || beat >= at || Date.parse(watch.usagePausedFor) >= at) continue;
    if (!last || at > Date.parse(last.failure.at)) last = { shortId, failure };
  }
  if (!last) return null;
  const at = Date.parse(last.failure.at);
  const resumeAt = parseResetTime(last.failure.message, at) || obs.now + retryMs(obs.config, watch.usageTries || 0);
  return { resumeAt, reason: `rate_limit ${last.shortId}`, failureAt: last.failure.at };
}

module.exports = {
  decide,
  usageVerdict,
  parseResetTime,
  retryMs,
  leadStatus,
  emptyWatch,
  wakeWithoutEffect,
  SILENT_MS,
  INEFFECTIVE_AFTER_MS,
  WAKE_BACKOFF_MS,
  INTERRUPT_SILENCE_MS,
  MAX_FAILED_RELAUNCHES,
  restartGraceMs,
  leadQuietMs,
  rateLimitHoldMs,
  questionSettings,
  QUESTION_REMIND_MS,
  usagePauseGraceMs,
};
