const test = require('node:test');
const assert = require('node:assert');
const { decide, leadStatus, emptyWatch, SILENT_MS, restartGraceMs } = require('../core/watcher-rules');

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

// Runs decide on `count` observations `stepMs` apart, each with the watch the previous one left.
// `at(now)` gives the fields of the observation at that time. Returns every action, in order.
function passes(count, stepMs, at) {
  let watch = emptyWatch();
  const actions = [];
  for (let i = 0; i < count; i++) {
    const now = T0 + i * stepMs;
    const result = decide(observation({ now, watch, ...at(now) }));
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
      obs: { readings: silentReadings, rows: [row(leadRecord, { state: 'done', idle: true })] },
      actions: [],
    },
  ];
  for (const { rule, obs, actions } of rows) {
    const decided = decide(observation(obs)).actions.map((action) =>
      action.type === 'stop-session'
        ? { type: action.type, shortId: action.session.shortId, log: action.log }
        : { type: action.type, text: action.text },
    );
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
    assert.deepStrictEqual(actions, [], `${leadRow.state}, idle`);
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
