// The watcher's rules ("Règles du veilleur" in the plan of lot 2a): what to do with a mission, from one
// observation of it. Pure: nothing is read here, the time comes from obs.now (ms). The actions are
// carried out by watcher.js (act), under the mission lock.
//
// obs: {now, mission, record (state.json), lead (lead.json), rows (the adapter's list, null when it
// failed), listError, tasksError, leadIdleConfirmed, registry, tasks (null when they could not be
// read), readings: {[shortId]: {heartbeat, statusline, failure}}, failures (the whole failures/
// folder, by short id), unseen, mail, config, watch (watch.json)}.
//
// Actions: {type: 'stop-session', session, log} and {type: 'log', text, journal}.

// An active lead whose last heartbeat is older than this is reported, never stopped.
const SILENT_MS = 30 * 60 * 1000;

// How long a lead working without a process, or missing from the list, may be restarting by itself
// (Claude's own service restarts a killed session in about 11 s, measured fact 4); also how recent a
// heartbeat keeps a lead missing from the list restarting. Read at each call: tests shorten it.
const restartGraceMs = () => Number(process.env.RELAYLEAD_RESTART_GRACE_MS) || 120000;

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

// Rules 2 to 4, 6 and 7. Returns {actions, watch}: watch is a new object, obs is left as it is.
function decide(obs) {
  const watch = { ...emptyWatch(), ...JSON.parse(JSON.stringify(obs.watch || {})) };
  const actions = [];
  const log = (text, journal = false) => actions.push({ type: 'log', text, journal });
  // A tripped mission still stopping: its stop is all there is to do.
  if (obs.record.stopping) return { actions, watch };

  logFailures(obs, watch, log);
  // Without the list, nothing is known of the sessions.
  if (obs.listError) {
    log(`list-failed ${obs.listError}`);
    return { actions, watch };
  }
  if (obs.tasksError) log(`tasks-failed ${obs.tasksError}`);
  stopExtraLeads(obs, actions);
  if (obs.tasks) stopOrphanCrew(obs, actions);
  watchLead(obs, watch, log);
  return { actions, watch };
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

// Rules 6 and 7, and the time the lead was first seen lost. A lead seen with a process gets a whole
// grace at its next loss.
function watchLead(obs, watch, log) {
  const row = leadRow(obs);
  const status = leadStatus(obs);
  const shortId = obs.lead.shortId;
  if (row && row.pid) {
    watch.leadLostSince = null;
  } else if (isLost(row)) {
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

module.exports = { decide, leadStatus, emptyWatch, SILENT_MS, restartGraceMs };
