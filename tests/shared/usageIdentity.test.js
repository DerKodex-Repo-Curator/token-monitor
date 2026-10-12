'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateDevices, aggregateHistory, normalizeDeviceRecord, normalizePeriod, mergeDeviceRecord, mergePeriods } = require('../../src/shared/usage');
const { normalizeUsageIdentity, packUsageIdentity } = require('../../src/shared/usageIdentity');
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
      timedOutputTokens: timed ? tokens / 10 : 0, timedDurationMs: timed ? tokens : 0, models: { [model]: tokens }, modelCosts: { [model]: cost } } },
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

test('inconsistent component and foreign client attribution cannot authorize deductions', () => {
  const initial = device('a', [{ id: id(1), usage: usage(100) }]);
  for (const [index, corrupt] of [
    row => { row.clientCacheReads.claude = 25; },
    row => { row.modelOutputs['claude-sonnet-4-5'] = 5; },
    row => { row.projects.repo.clients = { codex: 100 }; },
    row => { row.sessions['codex:session-a'] = row.sessions['claude:session-a']; delete row.sessions['claude:session-a']; },
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

test('counter tables preserve thousands of cumulative events within the existing upload budget', () => {
  const events = Array.from({ length: 2500 }, (_, index) => ({ id: id(index + 1), usage: usage(100) }));
  const record = device('a', events);
  const result = serializeSyncPayload(record);
  assert.ok(result.bytes < 1024 * 1024);
  assert.equal(normalizeDeviceRecord(result.payload).usageIdentity.periods.allTime.events.length, 2500);
  const other = { ...result.payload, deviceId: 'b' };
  assert.equal(aggregateDevices([result.payload, other], 600000, Date.parse(NOW)).periods.allTime.totalTokens, 250000);
});

test('counter table invalid references, duplicates, prototype paths, negative and overflowing counters fail closed', () => {
  const record = device('a', [{ id: id(1), usage: usage(100) }]);
  const packed = packUsageIdentity(normalizeDeviceRecord(record).usageIdentity);
  const corruptions = [
    value => { value.periods.today.events[0] = 999999; },
    value => { value.events[0][3].push(value.events[0][3][0], 1); },
    value => { value.paths[0] = ['__proto__', 'totalTokens']; },
    value => { value.events[0][3][1] = -1; },
    value => { value.events[0][3][1] = Number.MAX_SAFE_INTEGER + 1; },
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
