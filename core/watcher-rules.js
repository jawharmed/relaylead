// The watcher's rules ("Règles du veilleur" in the plan of lot 2a): what to do with a mission, from one
// observation of it. Pure: nothing is read here, the time comes from obs.now (ms). The actions are
// carried out by watcher.js (act), under the mission lock.
//
// obs: {now, mission, record (state.json), lead (lead.json), rows (the adapter's list, null when it
// failed), listError, tasksError, leadIdleConfirmed, registry, tasks (null when they could not be
// read), readings: {[shortId]: {heartbeat, statusline, failure}}, failures (the whole failures/
// folder, by short id), unseen (what the next `relaylead wait` would report, wait.js unseenChanges:
// {changes, viewKey, toFail, lostSince}, null without the list or the tasks), mail (unread messages
// by short id), config, watch (watch.json)}.
//
// Actions: {type: 'stop-session', session, log}, {type: 'log', text, journal}, {type: 'mark-failed',
// id, summary, log} and {type: 'wake-lead', reasons, log}.

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
// A lead held by a usage limit is not woken for this long after its failure; read at each call.
const rateLimitHoldMs = () => Number(process.env.RELAYLEAD_RATE_LIMIT_HOLD_MS) || 5 * 60 * 60 * 1000;
// A lead idle while the mission works, silent this long, has ended its turn (a command lasts 10 min
// at most).
const INTERRUPT_SILENCE_MS = 11 * 60 * 1000;

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
    rateLimitNoticeFor: null,
    unlistedNoticeFor: null,
    handoverNoticeFor: null,
    contextFullNotices: [],
    baseAlerts: [],
    silentNoticeFor: null,
    failuresSeen: {},
    tripped: false,
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

// Rules 2 to 7, 11 and 14 to 16. Returns {actions, watch, again}: watch is a new object, obs is left as
// it is. `again` asks a patient pass (a targeted one) to look again soon: the lead is active with
// something to wake it for once its turn ends, or a wake is held back by the quiet time, or by a crew
// failed in this pass.
function decide(obs) {
  const watch = { ...emptyWatch(), ...JSON.parse(JSON.stringify(obs.watch || {})) };
  const actions = [];
  const result = { actions, watch, again: false };
  const log = (text, journal = false) => actions.push({ type: 'log', text, journal });
  // A tripped mission still stopping: its stop is all there is to do.
  if (obs.record.stopping) return result;

  logFailures(obs, watch, log);
  // Without the list, nothing is known of the sessions.
  if (obs.listError) {
    log(`list-failed ${obs.listError}`);
    return result;
  }
  if (obs.tasksError) log(`tasks-failed ${obs.tasksError}`);
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
  if (status === 'idle') result.again = tendIdleLead(obs, watch, unseen, actions, log);
  if (status === 'active') result.again = Boolean(unseen && unseen.changes.length > 0) || (obs.mail || {})[obs.lead.shortId] > 0;
  return result;
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

// Rule 4: each failure newer than the last one seen of that session, registered or not.
function logFailures(obs, watch, log) {
  for (const [shortId, failure] of Object.entries(obs.failures || {})) {
    const at = Date.parse(failure.at);
    const seen = Date.parse(watch.failuresSeen[shortId]);
    if (!Number.isFinite(at) || (Number.isFinite(seen) && at <= seen)) continue;
    watch.failuresSeen[shortId] = failure.at;
    const message = String(failure.message || '-').replace(/\s+/g, ' ').trim();
    log(`session-failure ${shortId} ${failure.error || '-'}: ${message}`);
  }
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
// it started died before the lead could see what woke it (once the usage limit is over, rule 11, the
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

// Rules 11 and 14 to 16, for an idle lead: one wake at most, for every motive there is. True when a
// wake is held back only for a moment (quiet time, a crew failed by this pass): a patient pass looks
// again.
function tendIdleLead(obs, watch, unseen, actions, log) {
  if (rateLimited(obs, watch, log)) return false; // rule 11
  const motives = wakeMotives(obs, watch, unseen);
  if (motives.length === 0) return false;
  // A crew being failed by this pass: the lead is woken once its task is failed, at the next pass.
  if (unseen && unseen.toFail.length > 0) return true;
  if (obs.now - Date.parse(watch.lastLeadActionAt) < leadQuietMs()) return true;
  if (!wakeAllowed(obs, watch, log)) return false;
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

// Rule 11: a usage limit hit after the lead's last heartbeat, less than 5 h ago. Logged once per
// failure.
function rateLimited(obs, watch, log) {
  const failure = (obs.readings[obs.lead.shortId] || {}).failure;
  if (!failure || failure.error !== 'rate_limit') return false;
  const at = Date.parse(failure.at);
  if (!(at > Date.parse(lastBeat(obs))) || !(obs.now - at < rateLimitHoldMs())) return false;
  if (watch.rateLimitNoticeFor !== failure.at) {
    log(`lead-rate-limited ${obs.lead.shortId}`);
    watch.rateLimitNoticeFor = failure.at;
  }
  return true;
}

// The motives of rules 14 to 16, in order: {reasons (for the wake's text), log, remember (what watch
// keeps of it once the lead is woken)}.
function wakeMotives(obs, watch, unseen) {
  const motives = [];
  // Rule 14: changes the lead has not seen, once per view.
  if (unseen && unseen.changes.length > 0 && unseen.viewKey !== watch.lastWakeView) {
    const reasons = unseen.changes.map((change) => `${change.kind} ${change.id} is now ${change.to || 'gone'}`);
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

module.exports = {
  decide,
  leadStatus,
  emptyWatch,
  wakeWithoutEffect,
  SILENT_MS,
  INEFFECTIVE_AFTER_MS,
  WAKE_BACKOFF_MS,
  INTERRUPT_SILENCE_MS,
  restartGraceMs,
  leadQuietMs,
  rateLimitHoldMs,
};
