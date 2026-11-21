const test = require('node:test');
const assert = require('node:assert');
const {
  decide,
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
  usageVerdict,
  parseResetTime,
} = require('../core/watcher-rules');

const MINUTE = 60 * 1000;
const T0 = Date.parse('2026-11-20T10:00:00.000Z');
const LEAD = '1ead0001';
const OLD_LEAD = '1ead0000';
const CREW = 'c0de0001';

function iso(ms) {
  return new Date(ms).toISOString();
}

// A registry record and the row the adapter lists for it.
function session(shortId, name, role) {
  return { sessionId: `fake-${shortId}`, shortId, name, role, pid: 4242, cwd: '/project' };
}

function row(record, fields = {}) {
  return { ...record, state: 'working', pid: 4242, idle: false, ...fields };
}

const leadRecord = session(LEAD, 'demo/lead/2', 'lead');

// An observation as observe() returns it: mission demo working, its current lead active with a
// recent heartbeat, no crew. `fields` replaces any of it.
function observation(fields = {}) {
  return {
    now: T0,
    mission: { name: 'demo', createdAt: iso(T0 - 60 * MINUTE), config: {} },
    record: { state: 'working', updatedAt: iso(T0 - 10 * MINUTE) },
    lead: { sessionId: leadRecord.sessionId, shortId: LEAD, sessionName: leadRecord.name, startedAt: iso(T0 - 60 * MINUTE) },
    rows: [row(leadRecord)],
    listError: null,
    tasksError: null,
    leadIdleConfirmed: false,
    registry: [leadRecord],
    tasks: [],
    readings: { [LEAD]: { heartbeat: { at: iso(T0 - MINUTE), tool: 'Bash' }, statusline: null, failure: null } },
    failures: {},
    unseen: null,
    mail: {},
    config: {},
    watch: emptyWatch(),
    ...fields,
  };
}

// Runs decide on `count` observations `stepMs` apart, each with the watch the previous one left
// (`watch` to start from). `at(now, watch)` gives the fields of the observation at that time.
// Returns every action, in order.
function passes(count, stepMs, at, watch = emptyWatch()) {
  const actions = [];
  for (let i = 0; i < count; i++) {
    const now = T0 + i * stepMs;
    const result = decide(observation({ now, watch, ...at(now, watch) }));
    actions.push(...result.actions);
    watch = result.watch;
  }
  return { actions, watch };
}

function logs(actions) {
  return actions.filter((action) => action.type === 'log').map((action) => action.text);
}

function stopped(actions) {
  return actions.filter((action) => action.type === 'stop-session').map((action) => action.session.shortId);
}

function wakes(actions) {
  return actions.filter((action) => action.type === 'wake-lead');
}

// A heartbeat reading of the lead at `ms`.
function beat(ms, tool = 'Bash', fields = {}) {
  return { heartbeat: { at: iso(ms), tool, ...fields }, statusline: null, failure: null };
}

// What observe() gives of what the next `relaylead wait` would report.
function unseen(changes = [], fields = {}) {
  return { changes, viewKey: JSON.stringify(changes), toFail: [], lostSince: {}, ...fields };
}

const A_DONE = [{ kind: 'task', id: 'a', from: 'running', to: 'done' }];
const B_DONE = { kind: 'task', id: 'b', from: 'running', to: 'done' };
const A_FAILED = [{ kind: 'task', id: 'a', from: 'running', to: 'failed' }];
const IDLE_ROW = row(leadRecord, { state: 'done', idle: true });

// A lead that has ended its turn (done and idle with its process) in a mission that waits; its Stop
// hook beat 30 min ago, and nothing is unseen. `fields` replaces any of it.
function idle(fields = {}) {
  return {
    rows: [IDLE_ROW],
    record: { state: 'waiting', updatedAt: iso(T0 - 60 * MINUTE) },
    readings: { [LEAD]: beat(T0 - 30 * MINUTE, '(stop)') },
    unseen: unseen(),
    ...fields,
  };
}

// An idle lead that answers each wake: its Stop hook beats 1 s after it, seen from the next pass on.
function answering(fields = {}) {
  return (now, watch) => {
    const wakeAt = Date.parse(watch.lastLeadActionAt);
    const at = Number.isFinite(wakeAt) && now > wakeAt ? wakeAt + 1000 : T0 - 30 * MINUTE;
    return idle({ readings: { [LEAD]: beat(at, '(stop)') }, ...fields });
  };
}

// Like passes, from `start`: also gives the minutes after T0 of the passes that woke the lead.
function timeline(at, { count = 1, stepMs = MINUTE, start = T0, watch = emptyWatch() } = {}) {
  const actions = [];
  const minutes = [];
  for (let i = 0; i < count; i++) {
    const now = start + i * stepMs;
    const result = decide(observation({ now, watch, ...at(now, watch) }));
    if (wakes(result.actions).length > 0) minutes.push((now - T0) / MINUTE);
    actions.push(...result.actions);
    watch = result.watch;
  }
  return { actions, minutes, watch };
}

test('the rules table', () => {
  const extraLead = session(OLD_LEAD, 'demo/lead/1', 'lead');
  const crew = session(CREW, 'demo/developer/1', 'crew');
  const silentReadings = { [LEAD]: { heartbeat: { at: iso(T0 - 31 * MINUTE) }, statusline: null, failure: null } };
  const rows = [
    {
      rule: '2: a second lead with a process is stopped',
      obs: { registry: [leadRecord, extraLead], rows: [row(leadRecord), row(extraLead)] },
      actions: [{ type: 'stop-session', shortId: OLD_LEAD, log: `stop-extra-lead ${OLD_LEAD}` }],
    },
    {
      rule: '2: a second lead without a process is left alone',
      obs: { registry: [leadRecord, extraLead], rows: [row(leadRecord), row(extraLead, { state: 'done', pid: null })] },
      actions: [],
    },
    {
      rule: '3: a crew whose task is delivered is stopped',
      obs: {
        registry: [leadRecord, crew],
        rows: [row(leadRecord), row(crew)],
        tasks: [{ id: 'a', state: 'delivered', session: CREW }],
      },
      actions: [{ type: 'stop-session', shortId: CREW, log: `stop-orphan-crew ${CREW} task a` }],
    },
    {
      rule: '3: a crew that no task names is stopped',
      obs: { registry: [leadRecord, crew], rows: [row(leadRecord), row(crew)], tasks: [] },
      actions: [{ type: 'stop-session', shortId: CREW, log: `stop-orphan-crew ${CREW} task -` }],
    },
    {
      rule: '3: a crew whose task runs it is left alone',
      obs: {
        registry: [leadRecord, crew],
        rows: [row(leadRecord), row(crew)],
        tasks: [{ id: 'a', state: 'running', session: CREW }],
      },
      actions: [],
    },
    {
      rule: '4: a session failure is logged',
      obs: { failures: { [CREW]: { at: iso(T0 - MINUTE), error: 'rate_limit', message: 'limit reached' } } },
      actions: [{ type: 'log', text: `session-failure ${CREW} rate_limit: limit reached` }],
    },
    {
      rule: '6: a lead working without a process is restarting',
      obs: { rows: [row(leadRecord, { pid: null })] },
      actions: [{ type: 'log', text: `lead-restarting ${LEAD}` }],
    },
    {
      rule: '7: an active lead silent for 31 min is reported',
      obs: { readings: silentReadings },
      actions: [{ type: 'log', text: `lead-silent ${LEAD} 31 min` }],
    },
    {
      rule: '7: an idle lead silent for 31 min is not',
      obs: { readings: silentReadings, rows: [row(leadRecord, { state: 'done', idle: true })], record: { state: 'waiting' } },
      actions: [],
    },
    {
      rule: '5: a crew lost past the grace fails its task while the lead is idle',
      obs: idle({ unseen: unseen(A_FAILED, { toFail: [{ id: 'a', shortId: CREW, summary: 'crew session ended without a result' }] }) }),
      actions: [{ type: 'mark-failed', id: 'a', summary: 'crew session ended without a result', log: `crew-lost ${CREW} task a` }],
    },
    {
      rule: '5: not while the lead is active: its own wait does it',
      obs: { unseen: unseen(A_FAILED, { toFail: [{ id: 'a', shortId: CREW, summary: 'crew session ended without a result' }] }) },
      actions: [],
    },
    {
      rule: '20: a usage limit hit by the lead pauses the mission and stops its sessions at once',
      obs: idle({
        unseen: unseen(A_DONE),
        readings: { [LEAD]: { ...beat(T0 - 2 * MINUTE, '(stop)'), failure: { at: iso(T0 - MINUTE), error: 'rate_limit' } } },
      }),
      actions: [
        {
          type: 'pause-mission',
          resumeAt: T0 + 15 * MINUTE,
          reason: `rate_limit ${LEAD}`,
          wake: false,
          log: `usage-pause until ${iso(T0 + 15 * MINUTE)}: rate_limit ${LEAD}`,
        },
        { type: 'stop-session', shortId: LEAD, log: `usage-stop ${LEAD}` },
      ],
    },
    {
      rule: '14: an idle lead is woken for a change it has not seen',
      obs: idle({ unseen: unseen(A_DONE) }),
      actions: [{ type: 'wake-lead', reasons: ['task a is now done'], log: `wake-lead ${LEAD}: task a is now done` }],
    },
    {
      rule: '14: not when the tasks cannot be read',
      obs: idle({ tasks: null, tasksError: 'bad task file', unseen: null }),
      actions: [{ type: 'log', text: 'tasks-failed bad task file' }],
    },
    {
      rule: '15: an idle lead is woken for its mail',
      obs: idle({ mail: { [LEAD]: 1 } }),
      actions: [{ type: 'wake-lead', reasons: ['you have mail'], log: `wake-lead ${LEAD}: mail` }],
    },
    {
      rule: '10: an absent lead with a low context is resumed',
      obs: { rows: [row(leadRecord, { state: 'failed', pid: null })], readings: { [LEAD]: beat(T0 - MINUTE, 'Bash', { contextTokens: 50000, baseTokens: 40000 }) } },
      actions: [{ type: 'relaunch-lead', resume: true }],
    },
    {
      rule: '8: the breaker trips after 3 failed relaunches',
      obs: { rows: [row(leadRecord, { state: 'failed', pid: null })], watch: { ...emptyWatch(), failedRelaunches: 2, lastRelaunchAt: iso(T0 - 10 * MINUTE) }, readings: {} },
      actions: [{ type: 'log', text: 'breaker-tripped after 3 failed relaunches' }, { type: 'trip-breaker', afterLock: true }],
    },
    {
      rule: '16: an idle lead whose turn ended while the mission works is woken',
      obs: idle({ record: { state: 'working', updatedAt: iso(T0 - 40 * MINUTE) } }),
      actions: [
        { type: 'wake-lead', reasons: ['your turn ended while the mission was working'], log: `wake-lead ${LEAD}: turn ended while working` },
      ],
    },
  ];
  for (const { rule, obs, actions } of rows) {
    const decided = decide(observation(obs)).actions.map((action) => {
      if (action.type === 'stop-session') return { type: action.type, shortId: action.session.shortId, log: action.log };
      if (action.type === 'log') return { type: action.type, text: action.text };
      return action;
    });
    assert.deepStrictEqual(decided, actions, rule);
  }
});

test('a lead waiting for an input is never stopped', () => {
  // Its last heartbeat is hours old: an idle lead is not silent, only waiting.
  const readings = { [LEAD]: { heartbeat: { at: iso(T0 - 300 * MINUTE), tool: '(stop)' }, statusline: null, failure: null } };
  const idleRows = [
    [row(leadRecord, { state: 'waiting', idle: true }), 'waiting'],
    [row(leadRecord, { state: 'done', idle: true }), 'waiting'],
    [row(leadRecord, { state: 'working', idle: true }), 'working'],
  ];
  for (const [leadRow, state] of idleRows) {
    const { actions } = passes(10, 5 * MINUTE, () => ({
      rows: [leadRow],
      record: { state },
      readings,
      leadIdleConfirmed: true,
    }));
    // Never stopped nor reported; a lead idle while the mission works is only woken (rule 16).
    const kept = actions.filter((action) => action.type !== 'wake-lead');
    assert.deepStrictEqual(kept, [], `${leadRow.state}, idle`);
    if (state === 'waiting') assert.deepStrictEqual(actions, [], `${leadRow.state}, idle`);
    assert.strictEqual(leadStatus(observation({ rows: [leadRow], record: { state }, leadIdleConfirmed: true })), 'idle');
  }
  // One idle read alone is the start of a turn: the lead is active.
  assert.strictEqual(leadStatus(observation({ rows: [row(leadRecord, { idle: true })] })), 'active');
});

test('a second lead session with a process is stopped, not the current one', () => {
  const extraLead = session(OLD_LEAD, 'demo/lead/1', 'lead');
  const { actions } = decide(
    observation({ registry: [extraLead, leadRecord], rows: [row(extraLead, { state: 'done', idle: true }), row(leadRecord)] }),
  );
  assert.deepStrictEqual(stopped(actions), [OLD_LEAD]);
  assert.strictEqual(actions[0].session.name, 'demo/lead/1');
  assert.strictEqual(actions[0].log, `stop-extra-lead ${OLD_LEAD}`);
});

test('a crew session whose task no longer runs it is stopped', () => {
  const crew = session(CREW, 'demo/developer/1', 'crew');
  const cases = [
    [{ id: 'a', state: 'done', session: CREW }, 'a'],
    [{ id: 'a', state: 'delivered', session: CREW }, 'a'],
    // Retried: the task now runs another session, and no task names this one.
    [{ id: 'a', state: 'running', session: 'c0de0002' }, '-'],
    [null, '-'],
  ];
  for (const [task, id] of cases) {
    const { actions } = decide(
      observation({ registry: [leadRecord, crew], rows: [row(leadRecord), row(crew)], tasks: task ? [task] : [] }),
    );
    assert.deepStrictEqual(
      actions.map((action) => [action.type, action.session.shortId, action.log]),
      [['stop-session', CREW, `stop-orphan-crew ${CREW} task ${id}`]],
      JSON.stringify(task),
    );
  }
  // Its task runs it: left alone, even done and idle with its process.
  const { actions } = decide(
    observation({
      registry: [leadRecord, crew],
      rows: [row(leadRecord), row(crew, { state: 'done', idle: true })],
      tasks: [{ id: 'a', state: 'running', session: CREW }],
    }),
  );
  assert.deepStrictEqual(actions, []);
});

test('no crew is stopped when the tasks cannot be read', () => {
  const crew = session(CREW, 'demo/developer/1', 'crew');
  const { actions } = decide(
    observation({ registry: [leadRecord, crew], rows: [row(leadRecord), row(crew)], tasks: null, tasksError: 'bad task file' }),
  );
  assert.deepStrictEqual(stopped(actions), []);
  assert.deepStrictEqual(logs(actions), ['tasks-failed bad task file']);
});

test('a session failure is logged once, whether the session is registered or not', () => {
  const failure = { at: iso(T0 - MINUTE), error: 'rate_limit', message: 'limit\nreached' };
  const unregistered = { at: iso(T0 - 2 * MINUTE), error: 'server_error', message: null };
  const later = { at: iso(T0 + 7 * MINUTE), error: 'rate_limit', message: 'again' };
  const { actions } = passes(4, 5 * MINUTE, (now) => ({
    failures: { [LEAD]: now > T0 + 7 * MINUTE ? later : failure, '0ther001': unregistered },
  }));
  assert.deepStrictEqual(logs(actions), [
    `session-failure ${LEAD} rate_limit: limit reached`,
    'session-failure 0ther001 server_error: -',
    `session-failure ${LEAD} rate_limit: again`,
  ]);
});

test('a silent working lead is logged once after 30 min, never stopped', () => {
  // 30.5 min old at the third pass: past the 30 min.
  const beat = T0 - 20.5 * MINUTE;
  const { actions } = passes(8, 5 * MINUTE, () => ({
    readings: { [LEAD]: { heartbeat: { at: iso(beat) }, statusline: null, failure: null } },
  }));
  assert.deepStrictEqual(actions, [{ type: 'log', text: `lead-silent ${LEAD} 30 min`, journal: true }]);
  assert.ok(SILENT_MS === 30 * MINUTE);

  // A lead that never beat is aged from its start; a new silence after a heartbeat is logged again.
  const neverBeat = passes(2, 5 * MINUTE, () => ({ readings: {}, lead: { ...observation().lead, startedAt: iso(T0 - 31 * MINUTE) } }));
  assert.deepStrictEqual(logs(neverBeat.actions), [`lead-silent ${LEAD} 31 min`]);
  const again = decide(
    observation({
      now: T0 + 70 * MINUTE,
      watch: neverBeat.watch,
      readings: { [LEAD]: { heartbeat: { at: iso(T0 + 35 * MINUTE) } } },
    }),
  );
  assert.deepStrictEqual(logs(again.actions), [`lead-silent ${LEAD} 35 min`]);
});

test('a lead working without a process is restarting during the grace, then absent', () => {
  assert.strictEqual(restartGraceMs(), 120000);
  const grace = restartGraceMs();
  // The heartbeat is old: only the grace keeps it restarting.
  const readings = { [LEAD]: { heartbeat: { at: iso(T0 - 10 * MINUTE) } } };
  for (const rows of [[row(leadRecord, { pid: null })], []]) {
    let watch = emptyWatch();
    const statuses = [];
    const lines = [];
    for (const now of [T0, T0 + grace / 2, T0 + grace + 1000]) {
      const obs = observation({ now, watch, rows, readings });
      statuses.push(leadStatus(obs));
      const result = decide(obs);
      lines.push(...logs(result.actions));
      assert.deepStrictEqual(stopped(result.actions), []);
      watch = result.watch;
    }
    assert.deepStrictEqual(statuses, ['restarting', 'restarting', 'absent'], rows.length ? 'working without a process' : 'not listed');
    assert.deepStrictEqual(lines, [`lead-restarting ${LEAD}`]);
    assert.strictEqual(watch.leadLostSince, iso(T0));
    // Back with a process: a whole grace at the next loss.
    const back = decide(observation({ now: T0 + grace + 2000, watch }));
    assert.strictEqual(back.watch.leadLostSince, null);
  }
  // Stopped or failed: absent at once; a waiting mission's absent lead counts as idle.
  assert.strictEqual(leadStatus(observation({ rows: [row(leadRecord, { state: 'failed', pid: null })] })), 'absent');
  assert.strictEqual(leadStatus(observation({ rows: [row(leadRecord, { state: 'done', pid: null })] })), 'absent');
  assert.strictEqual(
    leadStatus(observation({ rows: [row(leadRecord, { state: 'stopped', pid: null })], record: { state: 'waiting' } })),
    'idle',
  );
});

test('a lead seen again, even without a process, gets a whole grace at its next loss', () => {
  const grace = restartGraceMs();
  const readings = { [LEAD]: { heartbeat: { at: iso(T0 - 10 * MINUTE) } } };
  // A waiting mission whose lead is not listed: restarting, then idle once the grace is over.
  let watch = emptyWatch();
  for (const now of [T0, T0 + grace + 1000]) {
    watch = decide(observation({ now, watch, rows: [], record: { state: 'waiting' }, readings })).watch;
  }
  assert.strictEqual(leadStatus(observation({ now: T0 + grace + 1000, watch, rows: [], record: { state: 'waiting' }, readings })), 'idle');
  // Listed again, stopped and without a process: still idle, and no longer lost.
  const later = T0 + 60 * MINUTE;
  watch = decide(observation({ now: later, watch, rows: [row(leadRecord, { state: 'done', pid: null })], record: { state: 'waiting' }, readings })).watch;
  assert.strictEqual(watch.leadLostSince, null);
  // Lost again once the mission works: a whole grace, and its line.
  const lost = observation({ now: later + 1000, watch, rows: [row(leadRecord, { pid: null })], readings });
  assert.strictEqual(leadStatus(lost), 'restarting');
  assert.deepStrictEqual(logs(decide(lost).actions), [`lead-restarting ${LEAD}`]);
});

test('an unlisted lead with a recent heartbeat is restarting, not absent', () => {
  const grace = restartGraceMs();
  const now = T0 + grace + 1000;
  const watch = { ...emptyWatch(), leadLostSince: iso(T0) };
  const readings = { [LEAD]: { heartbeat: { at: iso(now - 10 * 1000) } } };
  const obs = observation({ now, watch, rows: [], readings });
  assert.strictEqual(leadStatus(obs), 'restarting');
  const first = decide(obs);
  assert.deepStrictEqual(logs(first.actions), [`lead-unlisted-but-alive ${LEAD}`]);
  const second = decide(observation({ now: now + 5000, watch: first.watch, rows: [], readings }));
  assert.deepStrictEqual(second.actions, []);
  // Its heartbeat gets old: absent.
  assert.strictEqual(leadStatus(observation({ now: now + grace, watch, rows: [], readings })), 'absent');
});

test('a failed list applies no session rule', () => {
  const extraLead = session(OLD_LEAD, 'demo/lead/1', 'lead');
  const crew = session(CREW, 'demo/developer/1', 'crew');
  const watch = { ...emptyWatch(), leadLostSince: iso(T0 - MINUTE) };
  const { actions, watch: after } = decide(
    observation({
      rows: null,
      listError: 'claude agents timed out',
      registry: [leadRecord, extraLead, crew],
      readings: { [LEAD]: { heartbeat: { at: iso(T0 - 40 * MINUTE) } } },
      watch,
    }),
  );
  assert.deepStrictEqual(actions, [{ type: 'log', text: 'list-failed claude agents timed out', journal: false }]);
  assert.deepStrictEqual(after, watch);
});

test('decide changes neither the observation nor its watch', () => {
  const obs = observation({ rows: [row(leadRecord, { pid: null })] });
  const before = JSON.stringify(obs);
  const { watch } = decide(obs);
  assert.strictEqual(JSON.stringify(obs), before);
  assert.notStrictEqual(watch, obs.watch);
  assert.strictEqual(watch.leadLostSince, iso(T0));
});

test('an idle lead is woken for changes it has not seen, once per view', () => {
  const first = timeline(answering({ unseen: unseen(A_DONE) }), { count: 30 });
  assert.deepStrictEqual(first.minutes, [0]);
  assert.deepStrictEqual(wakes(first.actions), [
    { type: 'wake-lead', reasons: ['task a is now done'], log: `wake-lead ${LEAD}: task a is now done` },
  ]);
  assert.strictEqual(first.watch.lastWakeView, JSON.stringify(A_DONE));
  assert.strictEqual(timeline(answering({ unseen: unseen(A_DONE) })).watch.lastWakeAt, iso(T0));
  // A heartbeat after it: the wake worked, and is never judged again.
  assert.strictEqual(first.watch.lastWakeAt, null);
  assert.strictEqual(first.watch.lastLeadActionAt, iso(T0));

  // Another change: one more wake, with every change it has not seen.
  const answered = { kind: 'question', id: 'q-b', from: 'open', to: 'answered' };
  const second = timeline(answering({ unseen: unseen([...A_DONE, answered]) }), { count: 30, start: T0 + 30 * MINUTE, watch: first.watch });
  assert.deepStrictEqual(second.minutes, [30]);
  assert.deepStrictEqual(wakes(second.actions)[0].reasons, ['task a is now done', 'question q-b is now answered']);
  assert.strictEqual(wakes(second.actions)[0].log, `wake-lead ${LEAD}: task a is now done; question q-b is now answered`);
});

test('a view that comes back after a retry wakes the lead again', () => {
  const key = (attempt) => JSON.stringify({ questions: {}, tasks: { a: { attempt, state: 'failed' } } });
  const failedOnce = unseen(A_FAILED, { viewKey: key(1) });
  const failedTwice = unseen(A_FAILED, { viewKey: key(2) });
  const first = timeline(answering({ unseen: failedOnce }), { count: 5 });
  assert.deepStrictEqual(first.minutes, [0]);
  // Retried, failed again before the lead waited: the same change, another attempt.
  const second = timeline(answering({ unseen: failedTwice }), { count: 5, start: T0 + 10 * MINUTE, watch: first.watch });
  assert.deepStrictEqual(second.minutes, [10]);
  // The lead's wait has seen it all: the view is forgotten, and when it comes back it wakes the lead.
  const seen = timeline(answering({ unseen: unseen() }), { count: 1, start: T0 + 20 * MINUTE, watch: second.watch });
  assert.strictEqual(seen.watch.lastWakeView, null);
  assert.deepStrictEqual(seen.actions, []);
  const back = timeline(answering({ unseen: failedTwice }), { count: 1, start: T0 + 21 * MINUTE, watch: seen.watch });
  assert.deepStrictEqual(back.minutes, [21]);
});

test('an idle lead is woken for its mail', () => {
  // The woken lead reads its mail.
  const at = (now, watch) => ({ ...answering()(now, watch), mail: { [LEAD]: watch.lastLeadActionAt ? 0 : 1 } });
  const { minutes, actions } = timeline(at, { count: 10 });
  assert.deepStrictEqual(minutes, [0]);
  assert.deepStrictEqual(wakes(actions), [{ type: 'wake-lead', reasons: ['you have mail'], log: `wake-lead ${LEAD}: mail` }]);
});

test('an idle lead whose turn ended while working is woken once per state', () => {
  const working = (updatedAt) => (now, watch) => ({ ...answering()(now, watch), record: { state: 'working', updatedAt } });
  const first = timeline(working(iso(T0 - 40 * MINUTE)), { count: 20 });
  assert.deepStrictEqual(first.minutes, [0]);
  assert.deepStrictEqual(wakes(first.actions), [
    { type: 'wake-lead', reasons: ['your turn ended while the mission was working'], log: `wake-lead ${LEAD}: turn ended while working` },
  ]);
  assert.strictEqual(first.watch.interruptWakeFor, iso(T0 - 40 * MINUTE));
  // The lead woke, wrote a new state, and its turn ended again.
  const second = timeline(working(iso(T0 + 25 * MINUTE)), { count: 10, start: T0 + 30 * MINUTE, watch: first.watch });
  assert.deepStrictEqual(second.minutes, [30]);
});

test('a lead without a state yet is keyed on its start', () => {
  const { minutes, watch } = timeline(answering({ record: { state: 'starting' } }), { count: 10 });
  assert.deepStrictEqual(minutes, [0]);
  assert.strictEqual(watch.interruptWakeFor, observation().lead.startedAt);
});

test('a lead whose last heartbeat is recent and not a stop is not woken for an interrupted turn', () => {
  assert.strictEqual(INTERRUPT_SILENCE_MS, 11 * MINUTE);
  // 10, 11, then 12 min since its last tool.
  const at = () => idle({ record: { state: 'working', updatedAt: iso(T0 - 40 * MINUTE) }, readings: { [LEAD]: beat(T0 - 10 * MINUTE) } });
  assert.deepStrictEqual(timeline(at, { count: 3 }).minutes, [2]);
  // Nor is a lead that waits, whatever its heartbeat.
  assert.deepStrictEqual(timeline(() => idle({ readings: { [LEAD]: beat(T0 - 60 * MINUTE) } }), { count: 3 }).actions, []);
});

test('a lead that never beat is aged from its start', () => {
  const lead = { ...observation().lead, startedAt: iso(T0 - 10 * MINUTE) };
  const at = () => idle({ lead, readings: {}, record: { state: 'working', updatedAt: iso(T0 - 9 * MINUTE) } });
  assert.deepStrictEqual(timeline(at, { count: 3 }).minutes, [2]);
});

test('an idle lead with nothing new is left alone pass after pass', () => {
  const view = unseen(A_DONE);
  // Woken for that view an hour ago; it answered, and has waited since.
  const watch = { ...emptyWatch(), lastWakeView: view.viewKey, lastLeadActionAt: iso(T0 - 60 * MINUTE) };
  const readings = { [LEAD]: beat(T0 - 59 * MINUTE, '(stop)') };
  for (const leadRow of [IDLE_ROW, row(leadRecord, { state: 'waiting', idle: true })]) {
    const { actions, watch: after } = passes(10, 5 * MINUTE, () => idle({ rows: [leadRow], unseen: view, readings }), watch);
    assert.deepStrictEqual(actions, [], leadRow.state);
    assert.deepStrictEqual(after, watch, leadRow.state);
  }
  // Nothing unseen at all.
  assert.deepStrictEqual(passes(10, 5 * MINUTE, () => idle()).actions, []);
});

test('an absent lead of a waiting mission is left alone, then woken by a change', () => {
  const readings = { [LEAD]: beat(T0 - 180 * MINUTE, '(stop)') };
  // Stopped (claude lists it done without a process), or no longer listed, past the grace.
  const cases = [
    [[row(leadRecord, { state: 'done', pid: null, idle: true })], emptyWatch()],
    [[], { ...emptyWatch(), leadLostSince: iso(T0 - 60 * MINUTE) }],
  ];
  for (const [rows, watch] of cases) {
    const at = () => idle({ rows, readings });
    assert.strictEqual(leadStatus(observation({ watch, ...at() })), 'idle');
    const left = passes(10, 5 * MINUTE, at, watch);
    assert.deepStrictEqual(left.actions, [], `${rows.length} rows`);
    const woken = timeline(() => idle({ rows, readings, unseen: unseen(A_DONE) }), { start: T0 + 60 * MINUTE, watch: left.watch });
    assert.deepStrictEqual(woken.minutes, [60], `${rows.length} rows`);
  }
});

test('no wake within 10 s of a lead action', () => {
  assert.strictEqual(leadQuietMs(), 10000);
  const watch = { ...emptyWatch(), lastLeadActionAt: iso(T0 - 5000) };
  // 5, 9, then 13 s after the action.
  const { minutes } = timeline(answering({ unseen: unseen(A_DONE) }), { count: 3, stepMs: 4000, watch });
  assert.deepStrictEqual(minutes.map((minute) => Math.round(minute * MINUTE)), [8000]);
});

test('no second wake while the first one is not judged', () => {
  const later = unseen([...A_DONE, B_DONE]);
  // No heartbeat since the wake: a new change waits.
  const pending = timeline((now) => idle({ unseen: now === T0 ? unseen(A_DONE) : later }), { count: 5 });
  assert.deepStrictEqual(pending.minutes, [0]);
  // A heartbeat after the wake: the wake worked, and the new change wakes the lead.
  const judged = timeline(() => idle({ unseen: later, readings: { [LEAD]: beat(T0 + 4 * MINUTE, '(stop)') } }), {
    start: T0 + 4.5 * MINUTE,
    watch: pending.watch,
  });
  assert.deepStrictEqual(judged.minutes, [4.5]);
});

test('a wake that throws is tried again', () => {
  assert.deepStrictEqual(WAKE_BACKOFF_MS, [15 * MINUTE, 30 * MINUTE, 60 * MINUTE]);
  const at = () => idle({ unseen: unseen(A_DONE) });
  const first = timeline(at);
  // What act does when adapter.wake throws, 2 s later.
  const watch = { ...first.watch, ...wakeWithoutEffect(first.watch, T0 + 2000) };
  assert.strictEqual(watch.ineffectiveWakes, 1);
  assert.strictEqual(watch.lastIneffectiveAt, iso(T0 + 2000));
  assert.strictEqual(watch.lastWakeAt, null);
  assert.strictEqual(watch.lastWakeView, null);
  assert.strictEqual(watch.interruptWakeFor, null);
  const again = timeline(at, { count: 20, start: T0 + MINUTE, watch });
  assert.deepStrictEqual(again.minutes, [16]);
});

test('a wake for a change that had no effect is tried again after the backoff', () => {
  assert.strictEqual(INEFFECTIVE_AFTER_MS, 5 * MINUTE);
  const { minutes, watch } = timeline(() => idle({ unseen: unseen(A_DONE) }), { count: 25 });
  assert.deepStrictEqual(minutes, [0, 20]);
  assert.strictEqual(watch.ineffectiveWakes, 1);
  assert.strictEqual(watch.lastWakeView, JSON.stringify(A_DONE));
});

test('wakes without effect back off, then the lead is reported stuck', () => {
  const { minutes, actions, watch } = timeline(() => idle({ unseen: unseen(A_DONE) }), { count: 300 });
  // 15 min, 30 min, then 1 h after each wake judged without effect (5 min after it).
  assert.deepStrictEqual(minutes, [0, 20, 55, 120]);
  assert.deepStrictEqual(
    actions.filter((action) => action.type === 'log'),
    [{ type: 'log', text: `lead-stuck ${LEAD}`, journal: true }],
  );
  assert.strictEqual(watch.ineffectiveWakes, 4);
  assert.strictEqual(watch.stuckNoticeFor, LEAD);
});

test('a heartbeat after lead-stuck allows wakes again', () => {
  const watch = { ...emptyWatch(), ineffectiveWakes: 4, stuckNoticeFor: LEAD, lastIneffectiveAt: iso(T0 - 10 * MINUTE) };
  // Unblocked by hand at T0 + 90 s.
  const beatAt = (now) => (now >= T0 + 2 * MINUTE ? T0 + 90 * 1000 : T0 - 30 * MINUTE);
  const at = (now) => idle({ unseen: unseen(A_DONE), readings: { [LEAD]: beat(beatAt(now)) } });
  const { minutes, actions, watch: after } = timeline(at, { count: 3, watch });
  assert.deepStrictEqual(minutes, [2]);
  assert.deepStrictEqual(logs(actions), []);
  assert.strictEqual(after.ineffectiveWakes, 0);
  assert.strictEqual(after.stuckNoticeFor, null);
});

test('a heartbeat after a wake resets the backoff', () => {
  // Two wakes without effect already; the last one judged 31 min ago, after the lead's last heartbeat.
  const watch = { ...emptyWatch(), ineffectiveWakes: 2, lastIneffectiveAt: iso(T0 - 31 * MINUTE) };
  const at = (now) =>
    idle({
      unseen: now < T0 + 10 * MINUTE ? unseen(A_DONE) : unseen([...A_DONE, B_DONE]),
      // It answers the first wake only.
      readings: { [LEAD]: beat(now >= T0 + MINUTE ? T0 + MINUTE : T0 - 40 * MINUTE, '(stop)') },
    });
  // Woken once its 30 min are over; the count stays until it answers.
  assert.strictEqual(timeline(at, { watch }).watch.ineffectiveWakes, 2);
  const answered = timeline(at, { count: 2, watch });
  assert.strictEqual(answered.watch.ineffectiveWakes, 0);
  // The wake after it had no effect: 15 min, not 1 h, before the next one.
  assert.deepStrictEqual(timeline(at, { count: 40, watch }).minutes, [0, 10, 30]);
});

test('an active lead is never woken', () => {
  const at = () => ({
    unseen: unseen(A_DONE),
    mail: { [LEAD]: 2 },
    record: { state: 'working', updatedAt: iso(T0 - 40 * MINUTE) },
    readings: { [LEAD]: beat(T0 - 5 * MINUTE, '(stop)') },
  });
  assert.deepStrictEqual(wakes(passes(10, MINUTE, at).actions), []);
  // One idle read is the start of a turn.
  assert.deepStrictEqual(wakes(passes(10, MINUTE, () => ({ ...at(), rows: [row(leadRecord, { idle: true })] })).actions), []);
});

test('a crew lost while the lead is idle fails its task and wakes the lead', () => {
  const lost = { id: 'a', shortId: CREW, summary: 'crew session ended without a result' };
  const lostSince = { [CREW]: iso(T0 - 61 * 1000) };
  const first = decide(observation(idle({ unseen: unseen(A_FAILED, { toFail: [lost], lostSince }) })));
  assert.deepStrictEqual(first.actions, [{ type: 'mark-failed', id: 'a', summary: lost.summary, log: `crew-lost ${CREW} task a` }]);
  assert.deepStrictEqual(first.watch.crewLostSince, lostSince);
  // The task is failed: the next pass wakes the lead for it.
  const second = decide(observation({ now: T0 + MINUTE, watch: first.watch, ...idle({ unseen: unseen(A_FAILED) }) }));
  assert.deepStrictEqual(wakes(second.actions), [
    { type: 'wake-lead', reasons: ['task a is now failed'], log: `wake-lead ${LEAD}: task a is now failed` },
  ]);
  assert.deepStrictEqual(second.watch.crewLostSince, {});
  // An active lead's own wait fails the task; the watcher only keeps counting the grace.
  const active = decide(observation({ unseen: unseen(A_FAILED, { toFail: [lost], lostSince }) }));
  assert.deepStrictEqual(active.actions, []);
  assert.deepStrictEqual(active.watch.crewLostSince, lostSince);
});

test('a woken turn that fails after its first heartbeat is woken again', () => {
  // Woken at T0, it ran a command at 1 min, then its turn failed at 4 min, before its wait.
  const turnFailing = (error) => (now) =>
    idle({
      unseen: unseen(A_DONE),
      readings:
        now < T0 + 5 * MINUTE
          ? { [LEAD]: beat(T0 - 30 * MINUTE, '(stop)') }
          : { [LEAD]: { ...beat(T0 + MINUTE), failure: { at: iso(T0 + 4 * MINUTE), error } } },
    });
  // A failure that is not a usage limit (that one pauses the mission): woken again after the backoff, counted once.
  const failed = timeline(turnFailing('server_error'), { count: 5, stepMs: 5 * MINUTE });
  assert.deepStrictEqual(failed.minutes, [0, 20]);
  assert.strictEqual(failed.watch.ineffectiveWakes, 1);
  // A failure from before the wake says nothing of it.
  const oldFailure = { at: iso(T0 - 31 * MINUTE), error: 'server_error' };
  const before = () => idle({ unseen: unseen(A_DONE), readings: { [LEAD]: { ...beat(T0 - 30 * MINUTE, '(stop)'), failure: oldFailure } } });
  // Judged by the missing heartbeat alone, at 5 min.
  const old = timeline(before, { count: 2, stepMs: 4 * MINUTE });
  assert.deepStrictEqual([old.minutes, old.watch.ineffectiveWakes], [[0], 0]);
});

// A lead listed failed (killed): absent at once. `readings` of the lead, `watch` to start from.
function absent(fields = {}) {
  return { rows: [row(leadRecord, { state: 'failed', pid: null, idle: true })], ...fields };
}

function relaunches(actions) {
  return actions.filter((action) => action.type === 'relaunch-lead');
}

test('an absent lead is resumed when its context is known and low', () => {
  const readings = { [LEAD]: beat(T0 - 2 * MINUTE, 'Bash', { contextTokens: 60000, baseTokens: 40000 }) };
  assert.deepStrictEqual(relaunches(decide(observation(absent({ readings }))).actions), [{ type: 'relaunch-lead', resume: true }]);
  // An old reading of a dead lead is still right.
  const old = { [LEAD]: beat(T0 - 5 * 60 * MINUTE, 'Bash', { contextTokens: 60000, baseTokens: 40000 }) };
  assert.deepStrictEqual(relaunches(decide(observation(absent({ readings: old }))).actions), [{ type: 'relaunch-lead', resume: true }]);
});

test('an absent lead is relaunched as a new session when its context is high or unknown', () => {
  const high = { [LEAD]: beat(T0 - 2 * MINUTE, 'Bash', { contextTokens: 200000, baseTokens: 40000 }) };
  assert.deepStrictEqual(relaunches(decide(observation(absent({ readings: high }))).actions), [{ type: 'relaunch-lead', resume: false }]);
  assert.deepStrictEqual(relaunches(decide(observation(absent({ readings: {} }))).actions), [{ type: 'relaunch-lead', resume: false }]);
});

test('a relaunch counts as failed when the lead is absent again with no heartbeat since', () => {
  const relaunchedAt = T0 - 5 * MINUTE;
  const watch = { ...emptyWatch(), lastRelaunchAt: iso(relaunchedAt) };
  const readings = { [LEAD]: beat(relaunchedAt - MINUTE) };
  const result = decide(observation(absent({ watch, readings })));
  assert.strictEqual(result.watch.failedRelaunches, 1);
  assert.strictEqual(result.watch.lastFailedRelaunchAt, iso(T0));
  assert.strictEqual(relaunches(result.actions).length, 1);
  // Under the lock, the second observation reads watch.json again: the first decision is thrown away.
  assert.strictEqual(decide(observation(absent({ watch, readings }))).watch.failedRelaunches, 1);
});

test('a heartbeat after the relaunch resets the count and the relaunch time', () => {
  const relaunchedAt = T0 - 5 * MINUTE;
  const watch = { ...emptyWatch(), failedRelaunches: 2, lastRelaunchAt: iso(relaunchedAt), lastFailedRelaunchAt: iso(relaunchedAt - MINUTE) };
  const result = decide(observation({ watch, readings: { [LEAD]: beat(relaunchedAt + 1000) } }));
  assert.strictEqual(result.watch.failedRelaunches, 0);
  assert.strictEqual(result.watch.lastRelaunchAt, null);
  assert.strictEqual(result.watch.lastFailedRelaunchAt, null);
});

test('the breaker trips after 3 failed relaunches in a row, then only its stop is replayed', () => {
  assert.strictEqual(MAX_FAILED_RELAUNCHES, 3);
  let watch = emptyWatch();
  const kinds = [];
  for (let i = 0; i < 4; i++) {
    const now = T0 + i * 10 * MINUTE;
    const result = decide(observation(absent({ now, watch, readings: {} })));
    kinds.push(result.actions.filter((action) => action.type !== 'log').map((action) => action.type).join(','));
    // act sets lastRelaunchAt at the start of the relaunch; no heartbeat follows.
    watch = { ...result.watch, lastRelaunchAt: result.actions.some((action) => action.type === 'relaunch-lead') ? iso(now) : result.watch.lastRelaunchAt };
  }
  assert.deepStrictEqual(kinds, ['relaunch-lead', 'relaunch-lead', 'relaunch-lead', 'trip-breaker']);
  assert.strictEqual(watch.tripped, true);
  const replay = decide(observation({ record: { state: 'stopped', stopping: true }, watch }));
  assert.deepStrictEqual(replay.actions, [{ type: 'trip-breaker', afterLock: true }]);
});

test('the breaker never trips while the lead restarts', () => {
  const watch = { ...emptyWatch(), failedRelaunches: 3, lastRelaunchAt: iso(T0 - 10 * MINUTE), leadLostSince: iso(T0 - 1000) };
  const result = decide(observation({ watch, rows: [row(leadRecord, { pid: null })], readings: {} }));
  assert.deepStrictEqual(result.actions, []);
  assert.strictEqual(result.watch.tripped, false);
});

// A lead reading of `tokens` on a base of 40000 (soft 190000, hard 228000 with the default budgets).
function context(tokens, at = T0 - MINUTE, tool = 'Bash') {
  return { [LEAD]: beat(at, tool, { contextTokens: tokens, baseTokens: 40000 }) };
}

function handovers(actions) {
  return actions.filter((action) => action.type === 'hand-over');
}

test('a handover asked by the current lead or the user hands over', () => {
  for (const by of [leadRecord.name, 'user']) {
    const { actions } = decide(observation({ record: { state: 'handover', note: 'a done', by } }));
    assert.deepStrictEqual(handovers(actions), [{ type: 'hand-over', reason: 'asked', note: 'a done', tokens: null }], by);
  }
});

test('a handover asked by a replaced lead is ignored, and its absent lead relaunched', () => {
  const record = { state: 'handover', note: 'old', by: 'demo/lead/1' };
  assert.deepStrictEqual(decide(observation({ record })).actions, []);
  const { actions } = decide(observation(absent({ record, readings: {} })));
  assert.deepStrictEqual(actions, [{ type: 'relaunch-lead', resume: false }]);
});

test('an active lead past the hard threshold is handed over without its note', () => {
  const { actions } = decide(observation({ readings: context(230000) }));
  assert.deepStrictEqual(actions, [{ type: 'hand-over', reason: 'forced', note: null, tokens: 230000 }]);
  // A stale reading of an active lead triggers nothing.
  assert.deepStrictEqual(decide(observation({ readings: context(230000, T0 - 31 * MINUTE) })).actions.filter((a) => a.type !== 'log'), []);
});

test('an idle lead past the soft threshold is handed over instead of woken, and left alone with nothing to wake for', () => {
  const readings = context(200000, T0 - 30 * MINUTE, '(stop)');
  assert.deepStrictEqual(handovers(decide(observation(idle({ readings, unseen: unseen(A_DONE) }))).actions), [
    { type: 'hand-over', reason: 'idle', note: null, tokens: null },
  ]);
  assert.deepStrictEqual(wakes(decide(observation(idle({ readings, unseen: unseen(A_DONE) }))).actions), []);
  // Even past the hard threshold, nothing to wake for: left in peace.
  const hard = context(300000, T0 - 30 * MINUTE, '(stop)');
  assert.deepStrictEqual(decide(observation(idle({ readings: hard }))).actions, []);
});

test('an active lead past the soft threshold gets one notice', () => {
  const first = decide(observation({ readings: context(200000) }));
  assert.deepStrictEqual(first.actions.map((action) => [action.type, action.shortId, action.log]), [
    ['mail', LEAD, `notify-handover ${LEAD} 200000/190000`],
  ]);
  assert.match(first.actions[0].text, /^Your context holds 200000 tokens, past the handover threshold of 190000\. Finish the step/);
  assert.deepStrictEqual(decide(observation({ readings: context(205000), watch: first.watch })).actions, []);
});

test('a high base is logged once', () => {
  const readings = { [LEAD]: beat(T0 - MINUTE, 'Bash', { contextTokens: 170000, baseTokens: 160000 }) };
  const first = decide(observation({ readings }));
  assert.deepStrictEqual(logs(first.actions), [`base-high ${LEAD} 160000/310000`]);
  assert.deepStrictEqual(logs(decide(observation({ readings, watch: first.watch })).actions), []);
});

test('a crew member past the hard threshold gets one context-full mail, only with a measured window', () => {
  const crew = session(CREW, 'demo/developer/1', 'crew');
  const fields = (statusline) => ({
    registry: [leadRecord, crew],
    rows: [row(leadRecord), row(crew)],
    tasks: [{ id: 'a', state: 'running', session: CREW }],
    readings: { ...observation().readings, [CREW]: { heartbeat: null, statusline, failure: null } },
  });
  const measured = { at: iso(T0 - MINUTE), contextTokens: 50000, windowTokens: 100000, baseTokens: 30000 };
  const first = decide(observation(fields(measured)));
  assert.deepStrictEqual(first.actions.map((action) => [action.type, action.shortId, action.log]), [
    ['mail', CREW, `notify-context-full ${CREW} task a`],
  ]);
  assert.match(first.actions[0].text, /relaylead task fail a --summary "context full: /);
  assert.deepStrictEqual(decide(observation({ ...fields(measured), watch: first.watch })).actions, []);
  const unmeasured = { ...measured, windowTokens: null, contextTokens: 900000 };
  assert.deepStrictEqual(decide(observation(fields(unmeasured))).actions, []);
});

test('a hard handover and a wake never come in the same pass', () => {
  const { actions } = decide(observation({ readings: context(230000), mail: { [LEAD]: 1 } }));
  assert.deepStrictEqual(actions.map((action) => action.type), ['hand-over']);
});

// Rule 30. A question of the lead asked `ageMs` ago, or of the hooks with `kind`.
function openQuestion(id, ageMs, fields = {}) {
  return { id, key: id, text: `about ${id}`, options: ['yes', 'Skip this task'], recommended: 1, kind: null, state: 'open', askedAt: iso(T0 - ageMs), ...fields };
}

function questionActions(onTimeout, questions, watch = emptyWatch(), now = T0) {
  const config = onTimeout === undefined ? {} : { questions: { onTimeout, timeoutMinutes: 60 } };
  const result = decide(observation({ now, config, questions, watch }));
  return { actions: result.actions.filter((action) => action.type.endsWith('-question')), watch: result.watch };
}

test('recommended applies the recommended option of a question open past the delay', () => {
  const { actions } = questionActions('recommended', [openQuestion('q-a', 61 * MINUTE), openQuestion('q-b', 30 * MINUTE)]);
  assert.deepStrictEqual(actions, [{ type: 'answer-question', id: 'q-a', choice: 'yes', log: 'question-timeout-applied q-a yes' }]);
});

test('skip applies "Skip this task", or the recommended option without it', () => {
  const questions = [openQuestion('q-a', 61 * MINUTE), openQuestion('q-b', 61 * MINUTE, { options: ['go', 'stop'] })];
  const { actions } = questionActions('skip', questions);
  assert.deepStrictEqual(actions.map((action) => [action.id, action.choice]), [['q-a', 'Skip this task'], ['q-b', 'go']]);
});

test('wait only reminds, once in six hours', () => {
  let { actions, watch } = questionActions('wait', [openQuestion('q-a', 61 * MINUTE)]);
  assert.deepStrictEqual(actions, [
    { type: 'remind-question', id: 'q-a', text: 'Question q-a waits for your answer: about q-a', log: 'question-reminder q-a' },
  ]);
  assert.deepStrictEqual(watch.notifiedQuestions, { 'q-a': iso(T0) });
  const later = questionActions('wait', [openQuestion('q-a', 61 * MINUTE)], watch, T0 + 5 * 60 * MINUTE);
  assert.deepStrictEqual(later.actions, []);
  const next = questionActions('wait', [openQuestion('q-a', 61 * MINUTE)], watch, T0 + QUESTION_REMIND_MS);
  assert.deepStrictEqual(next.actions.map((action) => action.type), ['remind-question']);
});

test('a permission or irreversible question is never answered for the user', () => {
  const questions = [
    openQuestion('q-irr-0123456789ab', 61 * MINUTE, { kind: 'irreversible', options: ['Refuse', 'Allow once'] }),
    openQuestion('q-perm-0123456789ab', 61 * MINUTE, { kind: 'permission', options: ['Refuse', 'Allow once', 'Always allow in this mission'] }),
  ];
  for (const onTimeout of ['recommended', 'skip']) {
    const { actions } = questionActions(onTimeout, questions);
    assert.deepStrictEqual(actions.map((action) => action.type), ['remind-question', 'remind-question'], onTimeout);
  }
});

test('an unknown onTimeout value is wait', () => {
  const { actions } = questionActions('always', [openQuestion('q-a', 61 * MINUTE)]);
  assert.deepStrictEqual(actions.map((action) => action.type), ['remind-question']);
  assert.deepStrictEqual(questionSettings({ questions: { onTimeout: 'always', timeoutMinutes: 'x' } }), { onTimeout: 'wait', timeoutMs: 60 * MINUTE });
});

test('a question q-irr-… or q-perm-… without kind is never answered for the user', () => {
  const questions = [openQuestion('q-perm-0123456789ab', 61 * MINUTE, { options: ['Always allow in this mission', 'Refuse'] })];
  const { actions } = questionActions('recommended', questions);
  assert.deepStrictEqual(actions.map((action) => action.type), ['remind-question']);
});

// A usage measured `minutes` before T0, the 5-hour window at `fiveHour` % resetting at 1 h past T0,
// the week at `week` % resetting a day later.
function usage(fiveHour, week, minutes = 1) {
  return {
    at: iso(T0 - minutes * MINUTE),
    fiveHour: { percent: fiveHour, resetsAt: iso(T0 + 60 * MINUTE) },
    sevenDay: { percent: week, resetsAt: iso(T0 + 24 * 60 * MINUTE) },
  };
}

function withPriority(priority, fields) {
  return observation({ mission: { name: 'demo', priority, createdAt: iso(T0 - 60 * MINUTE), config: {} }, ...fields });
}

test('a measured usage pauses at the threshold of the priority, until its window resets', () => {
  const thresholds = { low: { week: 70, fiveHour: 80 }, normal: { week: 90, fiveHour: 85 }, high: { week: 98, fiveHour: 85 } };
  for (const [priority, limits] of Object.entries(thresholds)) {
    assert.strictEqual(usageVerdict(withPriority(priority, { usage: usage(limits.fiveHour - 1, limits.week - 1) })), null, priority);
    const fiveHour = usageVerdict(withPriority(priority, { usage: usage(limits.fiveHour, 10) }));
    assert.strictEqual(fiveHour.resumeAt, T0 + 60 * MINUTE, priority);
    const week = usageVerdict(withPriority(priority, { usage: usage(10, limits.week) }));
    assert.strictEqual(week.resumeAt, T0 + 24 * 60 * MINUTE, priority);
    // Both past: the later reset.
    assert.strictEqual(usageVerdict(withPriority(priority, { usage: usage(100, 100) })).resumeAt, T0 + 24 * 60 * MINUTE, priority);
  }
  assert.strictEqual(usageVerdict(withPriority('normal', { usage: usage(90, 10) })).reason, 'five-hour 90% >= 85%');
  // A stale usage says nothing; the thresholds come from the configuration of the mission.
  assert.strictEqual(usageVerdict(withPriority('normal', { usage: usage(99, 99, 31) })), null);
  const config = { usage: { thresholds: { normal: { fiveHour: 50 } } } };
  const configured = observation({ mission: { name: 'demo', priority: 'normal', config }, config, usage: usage(50, 10) });
  assert.strictEqual(usageVerdict(configured).resumeAt, T0 + 60 * MINUTE);
});

test('the time a usage limit resets is read from its message', () => {
  // In the machine's time zone, the next time it comes after the failure.
  const at = (hour, minute) => {
    const date = new Date(T0);
    date.setHours(hour, minute, 0, 0);
    return date.getTime();
  };
  const since = at(1, 0);
  assert.strictEqual(parseResetTime("You've hit your 5-hour limit · resets 2:54am (Europe/Paris)", since), at(2, 54));
  assert.strictEqual(parseResetTime('resets 11pm', since), at(23, 0));
  assert.strictEqual(parseResetTime('resets 12:30am', since), at(0, 30) + 24 * 60 * MINUTE);
  assert.strictEqual(parseResetTime('Limit reached, resets 9:15pm', at(22, 0)), at(21, 15) + 24 * 60 * MINUTE);
  for (const text of ['limit reached', 'resets soon', 'resets 13pm', null]) assert.strictEqual(parseResetTime(text, since), null, text);
});

test('a usage limit hit pauses until the time of its message, otherwise after 15, 30, then 60 min', () => {
  const failure = (message, minutes = 1) => ({ at: iso(T0 - minutes * MINUTE), error: 'rate_limit', message });
  const limited = (fail, watch = emptyWatch()) =>
    usageVerdict(observation({ watch, readings: { [LEAD]: { ...beat(T0 - 2 * MINUTE), failure: fail } } }));
  const resetsAt = new Date(T0 + 3 * 60 * MINUTE);
  const text = `You've hit your 5-hour limit · resets ${resetsAt.getHours() % 12 || 12}:${String(resetsAt.getMinutes()).padStart(2, '0')}${resetsAt.getHours() < 12 ? 'am' : 'pm'}`;
  assert.deepStrictEqual(limited(failure(text)), { resumeAt: resetsAt.getTime(), reason: `rate_limit ${LEAD}`, failureAt: iso(T0 - MINUTE) });
  const tries = [0, 1, 2, 3, 7].map((usageTries) => (limited(failure('limit reached'), { ...emptyWatch(), usageTries }).resumeAt - T0) / MINUTE);
  assert.deepStrictEqual(tries, [15, 30, 60, 60, 60]);
  // A crew member's limit counts too.
  const crew = session(CREW, 'demo/crew/1', 'crew');
  const fromCrew = observation({ registry: [leadRecord, crew], readings: { [LEAD]: beat(T0 - MINUTE), [CREW]: { heartbeat: null, failure: failure('x') } } });
  assert.strictEqual(usageVerdict(fromCrew).reason, `rate_limit ${CREW}`);
  // Not one before the last heartbeat, older than 5 h, of another error, or already paused for.
  assert.strictEqual(limited(failure('x', 3)), null);
  const old = { registry: [leadRecord, crew], readings: { [LEAD]: beat(T0 - MINUTE), [CREW]: { heartbeat: null, failure: failure('x', 301) } } };
  assert.strictEqual(usageVerdict(observation(old)), null);
  assert.strictEqual(limited({ ...failure('x'), error: 'server_error' }), null);
  assert.strictEqual(limited(failure('x'), { ...emptyWatch(), usagePausedFor: iso(T0 - MINUTE) }), null);
});

test('a measured usage past the threshold wakes a running lead to push its work, and stops nothing yet', () => {
  const { actions, watch } = decide(observation({ usage: usage(90, 10) }));
  assert.deepStrictEqual(actions, [
    { type: 'pause-mission', resumeAt: T0 + 60 * MINUTE, reason: 'five-hour 90% >= 85%', wake: true, log: `usage-pause until ${iso(T0 + 60 * MINUTE)}: five-hour 90% >= 85%` },
  ]);
  assert.strictEqual(watch.usageTries, 0);
  // A lead without a process is not woken: the sessions are stopped at once.
  const crew = session(CREW, 'demo/crew/1', 'crew');
  const absent = decide(observation({ usage: usage(90, 10), registry: [leadRecord, crew], rows: [row(leadRecord, { state: 'failed', pid: null }), row(crew)] }));
  assert.deepStrictEqual(absent.actions.map((action) => [action.type, action.wake]), [['pause-mission', false], ['stop-session', undefined]]);
});

test('a paused mission stops its sessions once its lead has ended its turn or past the grace, and starts nothing', () => {
  const crew = session(CREW, 'demo/crew/1', 'crew');
  const pause = { at: iso(T0 - MINUTE), reason: 'five-hour 90% >= 85%', resumeAt: iso(T0 + 60 * MINUTE) };
  const paused = (fields) => observation({ pause, registry: [leadRecord, crew], rows: [row(leadRecord), row(crew)], ...fields });
  // Active, within the grace: nothing, not even a pause again.
  assert.deepStrictEqual(decide(paused({ usage: usage(90, 10) })).actions, []);
  // Past the grace, or once the lead is idle: the crew, then the lead.
  for (const obs of [paused({ now: T0 + 2 * MINUTE }), paused({ rows: [IDLE_ROW, row(crew)] })]) {
    assert.deepStrictEqual(stopped(decide(obs).actions), [CREW, LEAD]);
  }
  // Nothing runs, before the time to resume: no relaunch of the absent lead, no crew failed as lost,
  // no wake for its changes, nothing counted for the breaker.
  const down = paused({
    now: T0 + 59 * MINUTE,
    rows: [row(leadRecord, { state: 'failed', pid: null }), row(crew, { state: 'failed', pid: null })],
    unseen: unseen(A_FAILED, { toFail: [{ id: 'a', shortId: CREW, summary: 'lost' }] }),
    watch: { ...emptyWatch(), lastRelaunchAt: iso(T0 - 10 * MINUTE) },
  });
  const left = decide(down);
  assert.deepStrictEqual(left.actions, []);
  assert.strictEqual(left.watch.failedRelaunches, 0);
});

test('a paused mission resumes at its time once the measured usage is under the threshold or unknown', () => {
  const pause = { at: iso(T0 - 70 * MINUTE), reason: 'five-hour 90% >= 85%', resumeAt: iso(T0) };
  const down = (fields) =>
    observation({ pause, rows: [row(leadRecord, { state: 'failed', pid: null })], watch: { ...emptyWatch(), leadLostSince: iso(T0 - 60 * MINUTE) }, ...fields });
  assert.deepStrictEqual(decide(down({ usage: usage(90, 10) })).actions, []);
  assert.deepStrictEqual(decide(down({ now: T0 - 1000, usage: usage(10, 10) })).actions, []);
  for (const fields of [{ usage: usage(10, 10) }, { usage: null }]) {
    const { actions, watch } = decide(down(fields));
    assert.deepStrictEqual(actions, [{ type: 'resume-mission', log: `usage-resumed ${LEAD}` }, { type: 'relaunch-lead', resume: false }]);
    assert.strictEqual(watch.leadLostSince, null);
  }
});

test('the tries after usage limits without a time grow until the lead works again', () => {
  const failure = (minutes) => ({ at: iso(T0 + minutes * MINUTE), error: 'rate_limit', message: 'limit reached' });
  const first = decide(observation({ now: T0 + MINUTE, readings: { [LEAD]: { ...beat(T0 - MINUTE), failure: failure(0) } } }));
  assert.strictEqual(first.watch.usageTries, 1);
  assert.strictEqual(first.actions[0].resumeAt, T0 + 16 * MINUTE);
  // Resumed, the lead fails again without having worked: 30 min this time.
  const again = decide(observation({ now: T0 + 20 * MINUTE, watch: first.watch, readings: { [LEAD]: { ...beat(T0 - MINUTE), failure: failure(19) } } }));
  assert.strictEqual(again.watch.usageTries, 2);
  assert.strictEqual(again.actions[0].resumeAt, T0 + 50 * MINUTE);
  // A heartbeat after the last limit: the tries start again.
  const worked = decide(observation({ now: T0 + 60 * MINUTE, watch: again.watch, readings: { [LEAD]: { ...beat(T0 + 59 * MINUTE), failure: failure(19) } } }));
  assert.strictEqual(worked.watch.usageTries, 0);
});

test('a paused mission still answers and reminds of its questions, and starts nothing', () => {
  const pause = { at: iso(T0 - 70 * MINUTE), reason: 'five-hour 90% >= 85%', resumeAt: iso(T0 + 60 * MINUTE) };
  const config = { questions: { onTimeout: 'recommended', timeoutMinutes: 60 } };
  const questions = [openQuestion('q-a', 61 * MINUTE), openQuestion('q-perm-0123456789ab', 61 * MINUTE, { kind: 'permission' })];
  const rows = [row(leadRecord, { state: 'failed', pid: null })];
  const { actions } = decide(observation({ pause, config, questions, rows, unseen: unseen(A_DONE) }));
  assert.deepStrictEqual(actions.map((action) => action.type), ['answer-question', 'remind-question']);
});
