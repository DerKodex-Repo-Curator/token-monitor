'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectUsageOnce, localTodayKey } = require('../../src/shared/collector');
const { extractUsageFromTokscale, mergePeriods, aggregateDevices } = require('../../src/shared/usage');
const { serializeSyncPayload } = require('../../src/shared/syncPayload');
const { sessionActivityState } = require('../../src/shared/sessionLive');
const { captureDailyHistoryArchive, graphFromDailyHistoryArchive } = require('../../src/shared/dailyHistoryArchive');
const { normalizeHistory, parseGraphResult } = require('../../src/shared/history');
const { applySourceDailyUsage } = require('../../src/shared/usage/sourceDailyUsage');
const { applySessionUsageArchive, isSessionUsageArchiveEvidence } = require('../../src/shared/usage/sessionUsageArchive');
const { createSessionUsageArchiveStore } = require('../../src/shared/usage/sessionUsageArchiveStore');
const { createUsageTransform } = require('../../src/shared/usage/usageTransform');

const now = new Date(2026, 9, 13, 12);
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const day = clock => localTodayKey(clock, zone);
const priorDay = new Date(now.getTime() - 86400000);
const olderDay = new Date(now.getTime() - 2 * 86400000);
const row = (id, input, clock = now) => ({ client: 'codex', sessionId: id, model: 'gpt-5.4', input, cost: input / 100, clock });
const native = rows => ({ entries: rows.map(({ clock: _clock, ...value }) => value) });
const period = rows => extractUsageFromTokscale(native(rows));
const periods = rows => Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, period(name === 'today' ? rows.filter(value => day(value.clock) === day(now)) : rows)]));
function graph(rows, capturedAt = now) {
  const contributions = rows.map(value => ({ date: day(value.clock), clients: [{ client: 'codex', modelId: value.model,
    providerId: 'openai', cost: value.cost, messages: 1,
    tokens: { input: value.input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }] }));
  return { contributions, sourceUsage: { version: 2, eventIdentityVersion: 2, capturedAt: capturedAt.toISOString(),
    fullHistory: true, bucketTimezone: zone, replacementClients: ['codex'], partialClients: [], rowsWithoutIdentity: {},
    scopes: [{ id: 'codex', clients: ['codex'], readStatus: 'complete', identityStatus: 'exact' }],
    sessions: [...new Set(rows.map(value => value.sessionId))].map(sessionId => ({ client: 'codex', sessionId,
      scopeId: 'codex', events: rows.filter(value => value.sessionId === sessionId).map(value => ({ id: `event:${sessionId}:${day(value.clock)}`,
        contributions: [{ timestamp: value.clock.getTime(), modelId: value.model, providerId: 'openai', cost: value.cost,
          messages: 1, tokens: { input: value.input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }] })) })) } };
}
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'source-ledger-review-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, options: { clients: 'codex', deviceId: 'review', allTimeSince: '2026-01-01', now, homeDir: home, env: {},
    projectsEnabled: false, wslScanEnabled: false, codexLocalUsageEnabled: false, includeHistory: true,
    dailyHistoryArchiveEnabled: true, sessionUsageArchive: { version: 1, sessions: {} },
    dailyHistoryArchiveOptions: { path: path.join(home, 'daily.json') },
    sessionMetadataDeps: { resolveSessionMetadata: () => null } } };
}
function project(archive, rows) {
  const summary = periods(rows);
  applySourceDailyUsage(summary, graphFromDailyHistoryArchive([], archive, { timeZone: zone }).sourceUsage,
    { todayKey: day(now), timeZone: zone, allTimeSince: '2026-01-01', nativePeriods: periods(rows) });
  summary.history = normalizeHistory(parseGraphResult(graphFromDailyHistoryArchive([], archive, { timeZone: zone })), { todayKey: day(now) });
  return summary;
}

test('cached noHistory projection preserves fresh native sessions after watch and still accepts a fresh downward graph', async t => {
  const f = fixture(t);
  let captured, projection;
  const first = await collectUsageOnce({ ...f.options, runTokscale: async () => native([row('A', 100)]),
    runGraph: async () => graph([row('A', 100)]), onAnchorComputed: value => { captured = value; },
    onSourceArchiveComputed: value => { projection = value; } });
  assert.equal(first.allTime.totalTokens, 100);
  const anchor = { ...captured.windowsPeriods, dateKey: captured.dateKey, timeZone: captured.timeZone,
    todayPartitions: captured.todayPartitions, nativeRawPresence: captured.nativeRawPresence };
  const fresh = [row('A', 150), row('B', 25)];
  const watch = await collectUsageOnce({ ...f.options, includeHistory: false, todayOnlyAnchor: anchor,
    sourceArchiveSnapshot: projection, runTokscale: async () => native(fresh) });
  assert.equal(watch.allTime.totalTokens, 175);
  const tray = await collectUsageOnce({ ...f.options, includeHistory: false, sourceArchiveSnapshot: projection,
    runTokscale: async () => native(fresh) });
  assert.equal(tray.allTime.totalTokens, 175);
  assert.equal(tray.allTime.sessions['codex:B'].totalTokens, 25);
  const correction = await collectUsageOnce({ ...f.options, now: new Date(now.getTime() + 1000),
    runTokscale: async () => native([row('A', 20)]), runGraph: async () => graph([row('A', 20)], new Date(now.getTime() + 1000)) });
  assert.equal(correction.allTime.totalTokens, 20);
});

test('history-only legacy scope initializes healthy native periods without acquiring exact ownership', () => {
  const old = graph([row('old', 100, priorDay)]);
  delete old.sourceUsage;
  const options = { todayKey: day(now), timeZone: zone, sessionUsageArchive: { version: 1, sessions: {} } };
  let archive = captureDailyHistoryArchive({}, old, options);
  archive = captureDailyHistoryArchive(archive, graph([], now), { ...options, nativePeriods: periods([]) });
  assert.equal(archive.sourceLedger.scopes.codex.legacyPeriods, undefined);
  const clock = new Date(now.getTime() + 1000);
  archive = captureDailyHistoryArchive(archive, graph([row('new', 5)], clock), { ...options, nativePeriods: periods([row('new', 5)]) });
  archive = JSON.parse(JSON.stringify(archive));
  const output = project(archive, [row('new', 5)]);
  assert.equal(output.today.totalTokens, 5);
  assert.equal(output.allTime.totalTokens, 105);
  assert.equal(archive.sourceLedger.scopes.codex.mode, 'legacy');
});

test('exclusive legacy graph absorbs offline historical dates without adding exact events twice', () => {
  const rows = [row('old', 100, olderDay), row('offline', 20, priorDay), row('new', 5)];
  const options = { todayKey: day(now), timeZone: zone, sessionUsageArchive: { version: 1, sessions: {} } };
  const old = graph(rows.slice(0, 1)); delete old.sourceUsage;
  let archive = captureDailyHistoryArchive({}, old, options);
  archive = captureDailyHistoryArchive(archive, graph(rows), { ...options, nativePeriods: periods(rows) });
  archive = captureDailyHistoryArchive(JSON.parse(JSON.stringify(archive)), graph(rows, new Date(now.getTime() + 1000)),
    { ...options, nativePeriods: periods(rows) });
  const output = project(archive, rows);
  assert.equal(output.allTime.totalTokens, 125);
  assert.equal(output.history.summary.totalTokens, 125);
  assert.equal(archive.sourceLedger.scopes.codex.mode, 'legacy');
  assert.deepEqual(archive.sourceLedger.scopes.codex.events, {});
});

for (const names of [['today'], ['month']]) test(`legitimate expired ${names[0]} tombstone remains valid migration evidence after SQLite reopen`, t => {
  const f = fixture(t);
  const options = { databasePath: path.join(f.home, 'sessions.sqlite'), path: path.join(f.home, 'sessions.json') };
  let store = createSessionUsageArchiveStore(options);
  try {
    store.capture(Object.fromEntries(names.map(name => [name, period([row('A', 100)])])), now);
    const later = names[0] === 'today' ? new Date(2026, 9, 14, 12) : new Date(2026, 10, 13, 12);
    store.read(later);
    store.close(); store = createSessionUsageArchiveStore(options);
    const evidence = store.readMigrationEvidence();
    assert.deepEqual(evidence.sessions['codex:A'].periods, {});
    assert.equal(isSessionUsageArchiveEvidence(evidence), true);
    assert.equal(isSessionUsageArchiveEvidence({ version: 1, sessions: { wrong: evidence.sessions['codex:A'] } }), false);
  } finally { store.close(); }
});

test('owned metadata capture and projection keep a confirmed title removal through reload', async t => {
  const f = fixture(t);
  const store = createSessionUsageArchiveStore({ databasePath: path.join(f.home, 'sessions.sqlite'), path: path.join(f.home, 'sessions.json') });
  const transform = createUsageTransform({ store });
  let revoked = false, unreadable = false;
  const observe = clock => collectUsageOnce({ ...f.options, now: clock, getSessionUsageArchive: () => store.readMigrationEvidence(),
    runTokscale: async () => native([row('A', 100)]), runGraph: async () => graph([row('A', 100)], clock),
    sessionMetadataDeps: { sessionMetadataResolvers: new Map([['codex', { resolve: () => unreadable ? new Map() : new Map([['A', revoked
      ? { invalidatedTitle: 'Old T3 title', titleOnly: true }
      : { title: 'Old T3 title', t3Title: 'Old T3 title', titleOnly: true }]]) }]]) } });
  try {
    const first = transform.transform(await observe(now));
    assert.equal(first.allTime.sessions['codex:A'].title, 'Old T3 title');
    unreadable = true;
    const unknown = transform.transform(await observe(new Date(now.getTime() + 1000)));
    assert.equal(unknown.allTime.sessions['codex:A'].title, 'Old T3 title', 'unknown lookup retains the latest title');
    unreadable = false;
    revoked = true;
    const removed = await observe(new Date(now.getTime() + 2000));
    assert.equal(removed.allTime.sessions['codex:A'].title || '', '');
    const displayed = transform.transform(removed);
    assert.equal(displayed.allTime.sessions['codex:A'].title || '', '');
    assert.equal(serializeSyncPayload(displayed).body.includes('revokedTitles'), false);
    const archive = JSON.parse(JSON.stringify(store.readMigrationEvidence()));
    const fresh = { ...periods([row('A', 100)]), sessionArchiveSource: { managedKeys: ['codex:A'], ownedClients: ['codex'], boundaryCheckedClients: ['codex'] } };
    assert.equal(applySessionUsageArchive(fresh, archive, { now }).allTime.sessions['codex:A'].title || '', '');
  } finally { store.close(); }
});

test('retained registry activity and archived peer merge in either order without granting live transcript authority', () => {
  const clock = new Date();
  const retained = { ...period([row('A', 100)]), sessions: { 'codex:A': { ...period([row('A', 100)]).sessions['codex:A'],
    retained: true, sourceState: 'unknown', liveActivity: { state: 'waiting', observedAt: clock.toISOString() } } } };
  const archived = period([row('A', 100)]); archived.sessions['codex:A'].archived = true;
  archived.sessions['codex:A'].contextTokens = 99; archived.sessions['codex:A'].contextWindow = 100;
  for (const inputs of [[retained, archived], [archived, retained]]) {
    const merged = mergePeriods(...JSON.parse(JSON.stringify(inputs))).sessions['codex:A'];
    assert.equal(sessionActivityState(merged, clock), 'waiting');
    assert.equal(merged.retained, true);
    assert.equal(sessionActivityState(merged, new Date(clock.getTime() + 600000)), 'idle');
    const devices = inputs.map((value, i) => JSON.parse(serializeSyncPayload({ deviceId: `device-${i}`, updatedAt: clock.toISOString(),
      ...Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, value])) }).body));
    // The wire intentionally omits allTime session detail; today/month carry it.
    const synced = aggregateDevices(devices, 0, clock.getTime()).periods.today.sessions['codex:A'];
    assert.equal(sessionActivityState(synced, clock), 'waiting');
    assert.equal(synced.retained, true);
  }
});

test('a newer unknown registry observation revokes retained waiting in either archive merge order', () => {
  const clock = new Date();
  const waiting = period([row('A', 1)]), unknown = period([row('A', 1)]), archived = period([row('A', 1)]);
  for (const value of [waiting, unknown]) {
    value.sessions['codex:A'].retained = true;
    value.sessions['codex:A'].sourceState = 'unknown';
  }
  waiting.sessions['codex:A'].liveActivity = { state: 'waiting', observedAt: new Date(clock.getTime() - 1000).toISOString() };
  unknown.sessions['codex:A'].liveActivity = { state: 'unknown', observedAt: clock.toISOString() };
  archived.sessions['codex:A'].archived = true;
  for (const values of [[waiting, archived, unknown], [archived, unknown, waiting], [unknown, waiting, archived]]) {
    const session = mergePeriods(...values).sessions['codex:A'];
    assert.equal(session.liveActivity.state, 'unknown');
    assert.equal(sessionActivityState(session, clock), 'idle');
  }
});
