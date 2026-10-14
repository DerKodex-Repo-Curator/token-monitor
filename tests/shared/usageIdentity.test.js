'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateDevices, aggregateHistory, normalizeDeviceRecord, normalizePeriod, mergeDeviceRecord, mergePeriods } = require('../../src/shared/usage');
const { normalizeUsageIdentity, packUsageIdentity } = require('../../src/shared/usageIdentity');
const workerUsage = require('../../worker/src/shared/usage');
const workerIdentity = require('../../worker/src/shared/usageIdentity');
const { normalizeHistory, parseGraphResult } = require('../../src/shared/history');
const { syncPayload, serializeSyncPayload } = require('../../src/shared/syncPayload');

const NOW = '2026-10-13T02:00:00.000Z';
const id = number => `sha256:${number.toString(16).padStart(64, '0')}`;
function usage(tokens, { model = 'claude-sonnet-4-5', cost = tokens / 1000000, sid = 'session-a', project = 'repo', timed = true } = {}) {
  return normalizePeriod({
    totalTokens: tokens, costUsd: cost, cacheReadTokens: tokens / 2, cacheWriteTokens: 0, outputTokens: tokens / 10,
    capabilities: { tokenComponents: true, throughput: true },
    timedTokens: timed ? tokens : 0, timedOutputTokens: timed ? tokens / 10 : 0, timedDurationMs: timed ? tokens : 0,
    modelThroughput: timed ? { [model]: { timedTokens: tokens, timedOutputTokens: tokens / 10, timedDurationMs: tokens } } : {},
    clients: { claude: tokens }, clientCosts: { claude: cost }, clientCacheReads: { claude: tokens / 2 }, clientOutputs: { claude: tokens / 10 },
    models: { [model]: tokens }, modelCosts: { [model]: cost }, modelCacheReads: { [model]: tokens / 2 }, modelOutputs: { [model]: tokens / 10 },
    clientModels: { claude: { [model]: tokens } }, clientModelCosts: { claude: { [model]: cost } },
    sessions: { [`claude:${sid}`]: { client: 'claude', sessionId: sid, projectId: project, projectLabel: project,
      totalTokens: tokens, costUsd: cost, messageCount: 1, cacheReadTokens: tokens / 2, outputTokens: tokens / 10,
      timedOutputTokens: timed ? tokens / 10 : 0, timedDurationMs: timed ? tokens : 0, models: { [model]: tokens }, modelCosts: { [model]: cost }, providers: { anthropic: tokens } } },
    projects: { [project]: { tokens, costUsd: cost, clients: { claude: tokens } } }
  });
}
function historyDay(tokens, date = '2026-10-13') {
  return parseGraphResult({ contributions: [{ date, clients: [{ client: 'claude', modelId: 'claude-sonnet-4-5',
    tokens: { input: tokens * 0.4, output: tokens * 0.1, cacheRead: tokens * 0.5, cacheWrite: 0 }, cost: tokens / 1000000, messages: 1 }] }] }).contributions[0];
}
function device(name, events, kind = 'native') {
  const period = mergePeriods(...events.map(event => event.usage));
  return { deviceId: name, hostname: name, updatedAt: NOW, receivedAt: NOW,
    today: period, month: period, allTime: period,
    periodWindows: { today: { key: '2026-10-13', endsAt: '2026-10-14T00:00:00.000Z' }, month: { key: '2026-10', endsAt: '2026-11-01T00:00:00.000Z' } },
    usageIdentity: { version: 1, eventIdentityVersion: 2, periods: Object.fromEntries(['today', 'month', 'allTime'].map(name => [name,
      { capturedAt: NOW, events: events.map(event => ({ ...event, observationKind: kind, sessionId: 'session-a' })) }])) } };
}

test('native events reconcile mirror duplicates across hostnames and keep disjoint turns and every period attribution', () => {
  const shared = { id: id(1), usage: usage(100) };
  const host = device('windows', [shared, { id: id(2), usage: usage(200) }], 'mirror');
  const remote = device('linux', [shared, { id: id(3), usage: usage(300) }]);
  const before = JSON.stringify([host, remote]);
  const result = aggregateDevices([host, remote], 600000, Date.parse(NOW));
  for (const period of Object.values(result.periods)) {
    assert.equal(period.totalTokens, 600);
    assert.equal(period.clients.claude, 600);
    assert.equal(period.models['claude-sonnet-4-5'], 600);
    assert.equal(period.clientModels.claude['claude-sonnet-4-5'], 600);
    assert.equal(period.cacheReadTokens, 300);
    assert.equal(period.outputTokens, 60);
    assert.equal(period.timedTokens, 600);
    assert.equal(period.timedDurationMs, 600);
    assert.equal(period.projects.repo.tokens, 600);
    assert.equal(period.sessions['claude:session-a'].totalTokens, 600);
    assert.equal(period.sessions['claude:session-a'].messageCount, 3);
    assert.equal(period.sessions['claude:session-a'].providers.anthropic, 600);
    assert.equal(period.costUsd, 0.0006);
  }
  assert.equal(result.devices.find(row => row.deviceId === 'windows').periods.allTime.totalTokens, 300);
  assert.equal(result.devices.find(row => row.deviceId === 'linux').periods.allTime.totalTokens, 400);
  assert.equal(JSON.stringify([host, remote]), before);
  assert.equal(aggregateDevices([remote, host], 600000, Date.parse(NOW)).periods.allTime.totalTokens, 600);
});

test('an exact native correction beats a newer larger mirror reading without max-total ownership', () => {
  const mirror = device('host', [{ id: id(1), usage: usage(200) }], 'mirror');
  const native = device('remote', [{ id: id(1), usage: usage(100) }]);
  for (const evidence of Object.values(mirror.usageIdentity.periods)) evidence.capturedAt = '2026-10-13T03:00:00.000Z';
  assert.equal(aggregateDevices([mirror, native], 600000, Date.parse(NOW)).periods.allTime.totalTokens, 100);
});

test('same session without native proof, invalid envelopes, and overclaims remain additive', () => {
  const native = device('a', [{ id: id(1), usage: usage(100) }]);
  const legacy = device('b', [{ id: id(1), usage: usage(100) }]);
  delete legacy.usageIdentity;
  assert.equal(aggregateDevices([native, legacy], 600000, Date.parse(NOW)).periods.allTime.totalTokens, 200);
  const invalid = structuredClone(native);
  invalid.usageIdentity.eventIdentityVersion = 99;
  assert.equal(normalizeDeviceRecord(invalid).usageIdentity, undefined);
  const overclaim = structuredClone(native);
  overclaim.usageIdentity.periods.allTime.events.push({ id: id(2), observationKind: 'native', usage: usage(100) });
  assert.equal(normalizeDeviceRecord(overclaim).usageIdentity.periods.allTime, undefined);
  const negative = structuredClone(native);
  negative.usageIdentity.periods.allTime.events[0].usage.totalTokens = -1;
  assert.equal(normalizeUsageIdentity(negative.usageIdentity, negative), null);
});

test('limits-only retains matching proof, a legacy full usage update clears it', () => {
  const initial = device('a', [{ id: id(1), usage: usage(100) }]);
  assert.ok(mergeDeviceRecord(initial, { deviceId: 'a', limitsOnly: true }).usageIdentity);
  const legacy = { ...initial }; delete legacy.usageIdentity;
  assert.equal(mergeDeviceRecord(initial, legacy).usageIdentity, undefined);
});

test('event model attribution and physical component totals bound session and throughput claims in both encodings', () => {
  const first = { id: id(1), usage: usage(100, { model: 'model-a' }) };
  const second = { id: id(2), usage: usage(100, { model: 'model-b' }) };
  const accepted = device('host', [first, second], 'mirror');
  for (const corrupt of [
    row => { row.modelThroughput = { 'model-b': row.modelThroughput['model-a'] }; },
    row => { row.sessions['claude:session-a'].models = { 'model-b': 100 }; row.sessions['claude:session-a'].modelCosts = { 'model-b': row.costUsd }; },
    row => { row.cacheReadTokens = 100; row.clientCacheReads.claude = 100; row.modelCacheReads['model-a'] = 100; row.outputTokens = 100; row.clientOutputs.claude = 100; row.modelOutputs['model-a'] = 100; }
  ]) {
    const raw = structuredClone(normalizeUsageIdentity(accepted.usageIdentity, accepted));
    // All-time uploads intentionally remove session detail before validation.
    // Exercise the session-bearing Today evidence in both encodings.
    delete raw.periods.month;
    delete raw.periods.allTime;
    for (const evidence of Object.values(raw.periods)) {
      evidence.events = [structuredClone(evidence.events[0])];
      corrupt(evidence.events[0].usage);
    }
    assert.equal(normalizeUsageIdentity(raw, accepted), null);
    assert.equal(packUsageIdentity(raw), null, 'packing must not repair malformed raw attribution');
    assert.equal(normalizeUsageIdentity(packUsageIdentity(raw), accepted), null);
  }
});

test('inconsistent component and foreign client attribution cannot authorize deductions', () => {
  const initial = device('a', [{ id: id(1), usage: usage(100) }]);
  for (const [index, corrupt] of [
    row => { row.clientCacheReads.claude = 25; },
    row => { row.modelOutputs['claude-sonnet-4-5'] = 5; },
    row => { row.projects.repo.clients = { codex: 100 }; },
    row => { row.sessions['codex:session-a'] = row.sessions['claude:session-a']; delete row.sessions['claude:session-a']; },
    row => { row.sessions['claude:other-session'] = row.sessions['claude:session-a']; delete row.sessions['claude:session-a']; },
    row => { row.sessions['claude:session-a'].models = { 'cost-model': 99.5 }; }
  ].entries()) {
    const raw = structuredClone(initial);
    for (const evidence of Object.values(raw.usageIdentity.periods)) {
      evidence.events[0].usage = structuredClone(evidence.events[0].usage);
      corrupt(evidence.events[0].usage);
    }
    assert.equal(normalizeDeviceRecord(raw).usageIdentity, undefined, `corruption ${index}`);
  }
});

test('event client/model buckets must match their model buckets before any duplicate deduction', () => {
  const first = { id: id(1), usage: usage(100, { model: 'model-a' }) };
  const second = { id: id(2), usage: usage(100, { model: 'model-b' }) };
  for (const event of [first, second]) {
    const model = Object.keys(event.usage.models)[0];
    Object.assign(event.usage, { unpricedTokens: 100, clientUnpricedTokens: { claude: 100 },
      modelUnpricedTokens: { [model]: 100 }, clientModelUnpricedTokens: { claude: { [model]: 100 } } });
  }
  const mirror = device('host', [first, second], 'mirror');
  const original = device('remote', [first]);
  for (const corrupt of [
    row => { row.clientModels.claude = { 'model-b': 100 }; },
    row => { row.clientModelCosts.claude = { 'model-b': row.costUsd }; },
    row => {
      row.unpricedTokens = 100; row.clientUnpricedTokens = { claude: 100 };
      row.modelUnpricedTokens = { 'model-a': 100 };
      row.clientModelUnpricedTokens = { claude: { 'model-b': 100 } };
    }
  ]) {
    const raw = structuredClone(normalizeUsageIdentity(mirror.usageIdentity, mirror));
    for (const evidence of Object.values(raw.periods)) {
      evidence.events = [structuredClone(evidence.events[0])];
      corrupt(evidence.events[0].usage);
    }
    assert.equal(packUsageIdentity(raw), null, 'packing must reject mismatched model/client token, cost and unpriced maps');
    for (const evidence of [raw, packUsageIdentity(raw)]) {
      const badMirror = { ...mirror, usageIdentity: evidence };
      for (const implementation of [{ normalizeUsageIdentity, aggregateDevices },
        { normalizeUsageIdentity: workerIdentity.normalizeUsageIdentity, aggregateDevices: workerUsage.aggregateDevices }]) {
        assert.equal(implementation.normalizeUsageIdentity(evidence, mirror), null);
        const result = implementation.aggregateDevices([badMirror, original], 600000, Date.parse(NOW));
        for (const period of Object.values(result.periods)) {
          assert.deepEqual({ ...period.clientModels.claude }, { 'model-a': 200, 'model-b': 100 });
          assert.equal(period.clientModelCosts.claude['model-b'], second.usage.costUsd);
        }
      }
    }
  }
});

test('an unlabeled session cannot authorize a deduction from an unrelated project', () => {
  const record = device('host', [{ id: id(1), usage: usage(100) }], 'mirror');
  for (const period of [record.today, record.month, record.allTime]) {
    delete period.sessions['claude:session-a'].projectLabel;
  }
  const raw = { ...record.usageIdentity, periods: { today: record.usageIdentity.periods.today } };
  assert.equal(normalizeUsageIdentity(raw, record), null);
  assert.equal(normalizeUsageIdentity(packUsageIdentity(raw), record), null);
});

test('expired native Today cannot erase a current mirror contribution', () => {
  const mirror = device('a', [{ id: id(1), usage: usage(100) }], 'mirror');
  const old = device('b', [{ id: id(1), usage: usage(200) }]);
  old.periodWindows.today.endsAt = '2026-10-13T00:00:00.000Z';
  assert.equal(aggregateDevices([old, mirror], 600000, Date.parse(NOW)).periods.today.totalTokens, 100);
});

test('History reconciles daily/monthly/model/components and recomputes summary from the same events', () => {
  const mirror = device('host', [{ id: id(1), usage: usage(100) }], 'mirror');
  const native = device('remote', [{ id: id(1), usage: usage(100) }, { id: id(2), usage: usage(200) }]);
  for (const [record, tokens] of [[mirror, [100]], [native, [100, 200]]]) {
    const days = tokens.map(value => historyDay(value));
    record.history = normalizeHistory({ contributions: days }, { todayKey: '2026-10-13' });
    record.usageIdentity.history = { capturedAt: NOW, events: days.map((day, index) => ({ id: id(index + 1),
      observationKind: record === mirror ? 'mirror' : 'native', days: [{ date: day.date, usage: day }] })) };
  }
  // normalizeHistory expects one row per day. Fold the two native rows as real graph does.
  native.history = aggregateHistory([{ history: native.history }], { todayKey: '2026-10-13' });
  const history = aggregateHistory([mirror, native], { todayKey: '2026-10-13' });
  assert.equal(history.summary.totalTokens, 300);
  assert.equal(history.summary.messages, 2);
  assert.equal(history.daily[0].tokens, 300);
  assert.equal(history.daily[0].cacheReadTokens, 150);
  assert.equal(history.daily[0].perModel['claude-sonnet-4-5'].tokens, 300);
  assert.equal(history.monthly[0].perClient.claude.tokens, 300);
  assert.ok(Math.abs(history.monthly[0].cost - 0.0003) < Number.EPSILON * 0.001);
});

test('sync never sends event paths/titles or all-time session detail; budget drops whole optional evidence first', () => {
  const record = device('a', [{ id: id(1), usage: usage(100) }]);
  const event = record.usageIdentity.periods.today.events[0];
  event.sourcePath = '/private/transcript'; event.nativeKey = 'secret'; event.usage.sessions['claude:session-a'].title = 'secret title';
  const payload = syncPayload(record);
  assert.ok(payload.usageIdentity);
  const decoded = normalizeDeviceRecord(payload).usageIdentity;
  assert.equal(decoded.periods.allTime.events[0].usage.sessions && Object.keys(decoded.periods.allTime.events[0].usage.sessions).length, 0);
  assert.ok(!decoded.periods.allTime.events[0].sessionId);
  assert.ok(!JSON.stringify(payload.usageIdentity).includes('secret'));
  assert.ok(!JSON.stringify(payload.usageIdentity).includes('/private'));
  const baseline = serializeSyncPayload({ ...record, usageIdentity: undefined });
  const reduced = serializeSyncPayload(record, { maxBytes: baseline.bytes + 10 });
  assert.equal(reduced.payload.usageIdentity, undefined);
  assert.equal(reduced.payload.allTime.totalTokens, 100);
});

test('fixed event rows preserve thousands of cumulative events within the existing upload budget', () => {
  const events = Array.from({ length: 2500 }, (_, index) => ({ id: id(index + 1), usage: usage(100) }));
  const record = device('a', events);
  const result = serializeSyncPayload(record);
  assert.ok(result.bytes < 1024 * 1024);
  assert.equal(normalizeDeviceRecord(result.payload).usageIdentity.periods.allTime.events.length, 2500);
  const other = { ...result.payload, deviceId: 'b' };
  assert.equal(aggregateDevices([result.payload, other], 600000, Date.parse(NOW)).periods.allTime.totalTokens, 250000);
});

test('fixed rows reject invalid references, duplicates, identifiers, negative and overflowing counters', () => {
  const record = device('a', [{ id: id(1), usage: usage(100) }]);
  const packed = packUsageIdentity(normalizeDeviceRecord(record).usageIdentity);
  const corruptions = [
    value => { value.periods.today.events[0] = 999999; },
    value => { value.events[0][4][0].push(structuredClone(value.events[0][4][0][0])); },
    value => { value.models[0] = '__proto__'; },
    value => { value.events[0][4][0][0][1] = -1; },
    value => { value.events[0][4][0][0][1] = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.events[0][4][0][0][2] = Infinity; },
    value => { value.events[0][4][0][0][0] = 999999; },
    value => { value.periods.today.events.push(value.periods.today.events[0]); },
    value => { value.events[0].push({ totalTokens: 1 }); },
    value => { value.paths = [['models', 'foreign']]; },
    value => { value.encoding = 'unknown'; }
  ];
  for (const corrupt of corruptions) {
    const input = structuredClone(packed); corrupt(input);
    assert.equal(normalizeUsageIdentity(input, record), null);
  }
  assert.equal({}.totalTokens, undefined);
});

test('native source evidence is never reparsed as a second usage input', () => {
  const { extractUsageFromTokscale, extractUsageBundleFromTokscale } = require('../../src/shared/usage');
  const json = { entries: [{ client: 'claude', model: 'model', input: 100 }], sourceUsage: {
    rootUsage: [{ client: 'claude', model: 'model', totalTokens: 100 }], sessions: [{ events: [{ contributions: [{ model: 'model', input: 100 }] }] }]
  } };
  assert.equal(extractUsageFromTokscale(json).totalTokens, 100);
  assert.equal(extractUsageBundleFromTokscale(json).period.totalTokens, 100);
});

test('explicit timed output separates timed from untimed fragments in one report group', () => {
  const { extractUsageFromTokscale } = require('../../src/shared/usage');
  const row = { client: 'claude', sessionId: 'session', model: 'model', input: 100, output: 40,
    performance: { totalDurationMs: 500, timedTokens: 80, timedOutputTokens: 10 } };
  const period = extractUsageFromTokscale({ entries: [row] });
  assert.equal(period.timedOutputTokens, 10);
  assert.equal(period.modelThroughput.model.timedOutputTokens, 10);
  assert.equal(period.sessions['claude:session'].timedOutputTokens, 10);
  delete row.performance.timedOutputTokens;
  assert.equal(extractUsageFromTokscale({ entries: [row] }).timedOutputTokens, 40);
});

test('fixed upload conserves mixed models, timing, explicit provider/session allocations and unpriced counters', () => {
  const { extractUsageFromTokscale } = require('../../src/shared/usage');
  const contribution = normalizePeriod(extractUsageFromTokscale({ entries: [
    { client: 'claude', sessionId: 'session-a', model: 'a', provider: 'one', input: 13, output: 3,
      reasoning: 2, cacheRead: 5, cacheWrite: 2, cost: 0.012, messages: 2, unpricedTokens: 3,
      performance: { timedTokens: 16, timedOutputTokens: 3, totalDurationMs: 111 } },
    { client: 'claude', sessionId: 'session-a', model: 'a', provider: 'two', input: 7, output: 2,
      cost: 0.003, messages: 1 },
    { client: 'claude', sessionId: 'session-a', model: 'b', provider: 'one', input: 5, output: 1,
      cost: 0, unpricedTokens: 6, messages: 1 }
  ] }));
  const record = device('a', [{ id: id(1), usage: contribution }]);
  const canonical = normalizeUsageIdentity(record.usageIdentity, record);
  const packed = packUsageIdentity(canonical);
  assert.equal(packed.encoding, 'event-rows-v1');
  assert.equal(packed.paths, undefined);
  const decoded = normalizeUsageIdentity(packed, record);
  assert.deepEqual(decoded.periods.today, canonical.periods.today);
  assert.deepEqual(decoded.periods.month, canonical.periods.month);
  assert.equal(Object.keys(decoded.periods.allTime.events[0].usage.sessions).length, 0);
  const session = decoded.periods.today.events[0].usage.sessions['claude:session-a'];
  assert.deepEqual(session.providers, canonical.periods.today.events[0].usage.sessions['claude:session-a'].providers);
  assert.equal(decoded.periods.today.events[0].usage.timedOutputTokens, 3);
  assert.equal(decoded.periods.today.events[0].usage.unpricedTokens, 9);
});

test('serial period captures and independent graph History share only equal accounting rows', () => {
  const record = device('a', [{ id: id(1), usage: usage(100) }]);
  for (const [index, name] of ['today', 'month', 'allTime'].entries()) {
    record[name] = usage((index + 1) * 100);
    record.usageIdentity.periods[name].capturedAt = `2026-10-13T02:0${index}:00.000Z`;
    record.usageIdentity.periods[name].events[0].usage = record[name];
  }
  const day = historyDay(400);
  record.history = normalizeHistory({ contributions: [day] }, { todayKey: '2026-10-13' });
  record.usageIdentity.history = { capturedAt: '2026-10-13T02:05:00.000Z', events: [
    { id: id(1), observationKind: 'native', days: [{ date: day.date, usage: day }] }
  ] };
  const packed = packUsageIdentity(normalizeUsageIdentity(record.usageIdentity, record));
  assert.equal(packed.events.length, 4);
  const decoded = normalizeUsageIdentity(packed, record);
  assert.deepEqual(['today', 'month', 'allTime'].map(name => decoded.periods[name].events[0].usage.totalTokens), [100, 200, 300]);
  assert.equal(decoded.history.events[0].days[0].usage.tokens, 400);
  assert.equal(decoded.history.capturedAt, '2026-10-13T02:05:00.000Z');

  // Session-free AllTime accounting with equal tokens but different cost or
  // timing must never borrow the earlier row.
  const same = device('a', [{ id: id(1), usage: usage(100) }]);
  const equalPacked = packUsageIdentity(normalizeUsageIdentity(same.usageIdentity, same));
  assert.equal(equalPacked.events.length, 1);
  for (const changed of [usage(100, { cost: 0.1 }), usage(100, { timed: false })]) {
    same.allTime = changed;
    same.usageIdentity.periods.allTime.events[0].usage = changed;
    assert.equal(packUsageIdentity(normalizeUsageIdentity(same.usageIdentity, same)).events.length, 2);
  }
});

test('fixed History preserves optional omitted components and monthly-only days', () => {
  const record = device('a', [{ id: id(1), usage: usage(100) }]);
  const day = historyDay(100);
  record.history = normalizeHistory({ contributions: [day] }, { todayKey: '2026-10-13' });
  record.usageIdentity.history = { capturedAt: NOW, events: [
    { id: id(1), observationKind: 'native', days: [{ date: day.date, usage: day }] }
  ] };
  // This is the current trimming contract: availability can differ between
  // root, client and model component counters.
  delete record.history.daily[0].cacheReadTokens;
  delete record.history.daily[0].perClient.claude.outputTokens;
  delete record.history.daily[0].perModel['claude-sonnet-4-5'].unclassifiedTokens;
  const canonical = normalizeUsageIdentity(record.usageIdentity, record);
  assert.ok(canonical.history);
  const packed = packUsageIdentity(canonical);
  assert.ok(packed);
  assert.deepEqual(normalizeUsageIdentity(packed, record).history, canonical.history);
  record.history.daily = [];
  const monthlyCanonical = normalizeUsageIdentity(record.usageIdentity, record);
  assert.deepEqual(normalizeUsageIdentity(packUsageIdentity(monthlyCanonical), record).history, monthlyCanonical.history);
});

test('fixed session attribution corruption and overclaims stay additive in Node and generated Worker', () => {
  const record = device('host', [{ id: id(1), usage: usage(100, { model: 'a' }) },
    { id: id(2), usage: usage(100, { model: 'b' }) }], 'mirror');
  const original = device('remote', [{ id: id(1), usage: usage(100, { model: 'a' }) }]);
  const canonical = normalizeUsageIdentity(record.usageIdentity, record);
  canonical.periods = { today: { ...canonical.periods.today, events: [canonical.periods.today.events[0]] } };
  const packed = packUsageIdentity(canonical);
  for (const corrupt of [
    value => { value.events[0][4][1][0][1][0][0] = value.models.push('foreign') - 1; },
    value => { value.events[0][4][0][0][2] = 1; },
    value => { value.events[0][4][0][0][3] = 101; },
    value => { value.events[0][4][0][0][0] = value.models.push('foreign') - 1; },
    value => { value.events[0][4][0][0].push({ clientModels: { claude: { b: 100 } } }); }
  ]) {
    const wire = structuredClone(packed); corrupt(wire);
    for (const implementation of [{ normalizeUsageIdentity, aggregateDevices },
      { normalizeUsageIdentity: workerIdentity.normalizeUsageIdentity, aggregateDevices: workerUsage.aggregateDevices }]) {
      assert.equal(implementation.normalizeUsageIdentity(wire, record), null);
      assert.equal(implementation.aggregateDevices([{ ...record, usageIdentity: wire }, original], 600000, Date.parse(NOW)).periods.today.totalTokens, 300);
    }
  }
});

test('AllTime-only proof adds no session/provider detail and unsupported draft encoding stays additive', () => {
  const record = device('a', [{ id: id(1), usage: usage(100) }]);
  const canonical = normalizeUsageIdentity(record.usageIdentity, record);
  canonical.periods = { allTime: canonical.periods.allTime };
  const packed = packUsageIdentity(canonical);
  assert.deepEqual(packed.sessions, []);
  assert.deepEqual(packed.providers, []);
  assert.deepEqual(packed.events[0][4][1], []);
  assert.ok(normalizeUsageIdentity(packed, record));
  packed.encoding = 'counter-table-v1';
  assert.equal(normalizeUsageIdentity(packed, record), null);
});
