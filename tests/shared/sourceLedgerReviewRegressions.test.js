'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectUsageOnce, startCollector, localTodayKey } = require('../../src/shared/collector');
const { extractUsageFromTokscale, mergePeriods, aggregateDevices } = require('../../src/shared/usage');
const { serializeSyncPayload } = require('../../src/shared/syncPayload');
const { sessionActivityState } = require('../../src/shared/sessionLive');
const { captureDailyHistoryArchive, graphFromDailyHistoryArchive } = require('../../src/shared/dailyHistoryArchive');
const { normalizeHistory, parseGraphResult } = require('../../src/shared/history');
const { applySourceDailyUsage } = require('../../src/shared/usage/sourceDailyUsage');
const { applySessionUsageArchive, isSessionUsageArchiveEvidence } = require('../../src/shared/usage/sessionUsageArchive');
const { createSessionUsageArchiveStore } = require('../../src/shared/usage/sessionUsageArchiveStore');
const { createUsageTransform } = require('../../src/shared/usage/usageTransform');
const { captureArchivedClientUsage } = require('../../src/shared/usage/clientUsageArchive');
const { retainDailyHistory } = require('../../src/shared/dailyHistoryArchive');

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
  return { home, options: { clients: 'codex', deviceId: 'review', allTimeSince: '2026-01-01', now, homeDir: home, env: {}, osInfo: {},
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

test('full and cached source projection leave disabled legacy usage to its frozen client archive', async t => {
  const f = fixture(t);
  const released = { contributions: [{ date: day(now), clients: [{ client: 'claude', modelId: 'claude-model',
    cost: 1, messages: 1, tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }] }] };
  fs.writeFileSync(f.options.dailyHistoryArchiveOptions.path, JSON.stringify(captureDailyHistoryArchive({}, released)));
  const firstGraph = graph([row('A', 20)]);
  firstGraph.sourceUsage.replacementClients.push('claude');
  firstGraph.sourceUsage.scopes.push({ id: 'claude', clients: ['claude'], readStatus: 'complete', identityStatus: 'exact' });
  let projection;
  const before = await collectUsageOnce({ ...f.options, clients: 'claude,codex',
    runTokscale: async () => ({ entries: [...native([row('A', 20)]).entries,
      { client: 'claude', sessionId: 'old', model: 'claude-model', input: 100, cost: 1 }] }),
    runGraph: async () => firstGraph, onSourceArchiveComputed: value => { projection = value; } });
  assert.equal(before.allTime.totalTokens, 120);
  assert.equal(projection.scopes.find(scope => scope.id === 'claude').mode, 'legacy');
  const frozen = captureArchivedClientUsage({}, before, 'claude');
  const transform = createUsageTransform({ store: {}, getSettings: () => ({ clients: 'codex', archivedClientUsage: frozen }) });
  for (const includeHistory of [true, false]) {
    const selected = await collectUsageOnce({ ...f.options, clients: 'codex', includeHistory,
      sourceArchiveSnapshot: projection, now: new Date(now.getTime() + 1000),
      runTokscale: async () => native([row('A', 20)]), runGraph: async () => graph([row('A', 20)], new Date(now.getTime() + 1000)) });
    assert.equal(selected.allTime.totalTokens, 20, 'active projection excludes disabled Claude');
    const visible = transform.project(selected, { version: 1, sessions: {} }, now);
    assert.equal(visible.allTime.totalTokens, 120);
    assert.equal(visible.allTime.clients.claude, 100);
    assert.equal(visible.allTime.clients.codex, 20);
  }
});

test('failed daily writes protect committed source usage through cached full-native scans, restart and recovery', async t => {
  const f = fixture(t);
  let input = 45, partial = false, failWrite = false, projection;
  const failures = [];
  const options = { ...f.options,
    runTokscale: async () => native([row('A', input)]),
    runGraph: async () => {
      const value = graph([row('A', input)], new Date(now.getTime() + 1000));
      if (partial) value.sourceUsage.scopes[0].readStatus = 'partial';
      return value;
    }, onSourceArchiveComputed: value => { projection = value; },
    onHistoryStatus: value => failures.push(value),
    dailyHistoryArchiveOptions: { ...f.options.dailyHistoryArchiveOptions,
      writeJsonAtomic: (file, value) => {
        if (failWrite) throw Object.assign(new Error('read-only disk'), { code: 'EROFS' });
        fs.writeFileSync(file, JSON.stringify(value));
      } } };
  assert.equal((await collectUsageOnce(options)).allTime.totalTokens, 45);
  const committed = fs.readFileSync(f.options.dailyHistoryArchiveOptions.path);
  input = 15; partial = true; failWrite = true;
  const failed = await collectUsageOnce({ ...options, sourceArchiveSnapshot: projection });
  assert.equal(failed.allTime.totalTokens, 45);
  assert.equal(failed.history.summary.totalTokens, 45);
  assert.deepEqual(failed.sessionArchiveSource.ownedClients, ['codex']);
  assert.equal(projection.scopes[0].blockNativeWatch, true);
  assert.deepEqual(fs.readFileSync(f.options.dailyHistoryArchiveOptions.path), committed);
  const cached = await collectUsageOnce({ ...options, includeHistory: false, sourceArchiveSnapshot: projection });
  assert.equal(cached.allTime.totalTokens, 45);
  const restarted = await collectUsageOnce({ ...options, sourceArchiveSnapshot: undefined });
  assert.equal(restarted.allTime.totalTokens, 45);
  assert.equal(restarted.history.summary.totalTokens, 45);
  failWrite = false;
  assert.equal((await collectUsageOnce(options)).allTime.totalTokens, 45);
  partial = false;
  options.runGraph = async () => graph([row('A', 15)], new Date(now.getTime() + 2000));
  const lastCommitted = fs.readFileSync(f.options.dailyHistoryArchiveOptions.path);
  failWrite = true;
  const healthyButUncommitted = await collectUsageOnce(options);
  assert.equal(healthyButUncommitted.allTime.totalTokens, 45);
  assert.equal(healthyButUncommitted.history.summary.totalTokens, 45);
  assert.deepEqual(fs.readFileSync(f.options.dailyHistoryArchiveOptions.path), lastCommitted);
  failWrite = false;
  const recovered = await collectUsageOnce(options);
  assert.equal(recovered.allTime.totalTokens, 15);
  assert.equal(recovered.history.summary.totalTokens, 15);
  assert.notEqual(projection.scopes[0].blockNativeWatch, true);
  assert.ok(failures.some(value => value.failureCode === 'daily-history-archive-failed'));
});

for (const restart of [false, true]) test(`failed daily write locks survive unavailable History and anchored watch; restart=${restart}`, async t => {
  const f = fixture(t);
  let input = 45, clock = now, partial = false, failWrite = false, unavailable = false;
  const updates = [], scans = [];
  let graphCalls = 0;
  const options = { ...f.options, now: () => clock, includeHistory: undefined,
    watchEnabled: false, sessionActivityPolling: false, anchorPersistenceEnabled: false,
    intervalMs: 3600000,
    runTokscale: async ({ flags }) => { scans.push(flags); return native([row('A', input)]); },
    runGraph: async () => {
      graphCalls++;
      if (unavailable) throw new Error('offline graph unavailable');
      const value = graph([row('A', input)], clock);
      if (partial) value.sourceUsage.scopes[0].readStatus = 'partial';
      return value;
    },
    dailyHistoryArchiveOptions: { ...f.options.dailyHistoryArchiveOptions,
      writeJsonAtomic: (file, value) => {
        if (failWrite) throw Object.assign(new Error('read-only disk'), { code: 'EROFS' });
        fs.writeFileSync(file, JSON.stringify(value));
      } },
    onUpdate: value => updates.push(value) };
  const check = (expected) => {
    const value = updates.at(-1);
    for (const name of ['today', 'month', 'allTime']) {
      assert.equal(value[name].totalTokens, expected, name);
      assert.equal(value[name].sessions['codex:A'].totalTokens, expected, `${name} session`);
    }
    assert.deepEqual(value.sessionArchiveSource.ownedClients, ['codex']);
  };
  let runtime = startCollector(options);
  try {
    await runtime.whenIdle();
    check(45);
    const committed = fs.readFileSync(f.options.dailyHistoryArchiveOptions.path);
    input = 15; partial = true; failWrite = true; clock = new Date(now.getTime() + 1000);
    await runtime.tick('manual', { forceHistory: true });
    check(45);
    assert.deepEqual(fs.readFileSync(f.options.dailyHistoryArchiveOptions.path), committed);
    unavailable = true; clock = new Date(now.getTime() + 2000);
    if (restart) {
      runtime.stop(); await runtime.whenIdle();
      runtime = startCollector(options);
      await runtime.whenIdle();
    } else await runtime.tick('manual', { forceHistory: true });
    check(45);
    assert.equal(updates.at(-1).history.summary.totalTokens, 45);
    assert.deepEqual(fs.readFileSync(f.options.dailyHistoryArchiveOptions.path), committed);
    const graphsBeforeWatch = graphCalls;
    scans.length = 0; clock = new Date(now.getTime() + 3000);
    await runtime.tick('watch:fixture', { todayOnly: true });
    assert.deepEqual(scans, [['--today']], 'the regression uses an actual anchored watch');
    assert.equal(graphCalls, graphsBeforeWatch, 'watch skips unavailable History');
    check(45);
    unavailable = false; partial = false; failWrite = false; clock = new Date(now.getTime() + 4000);
    await runtime.tick('manual', { forceHistory: true });
    check(15);
    assert.notEqual(JSON.parse(fs.readFileSync(f.options.dailyHistoryArchiveOptions.path)).sourceLedger.scopes.codex.blockNativeWatch, true);
    input = 20; scans.length = 0; clock = new Date(now.getTime() + 5000);
    await runtime.tick('watch:fixture', { todayOnly: true });
    assert.deepEqual(scans, [['--today']]);
    check(20);
    assert.equal(runtime.getDiagnostics().lastHistoryFailureCode, null);
  } finally { runtime.stop(); await runtime.whenIdle(); }
});

test('an identical healthy revision releases a failed-write lock only after a successful commit', async t => {
  const f = fixture(t);
  let input = 45, partial = false, failWrite = false, writes = 0, projection;
  const options = { ...f.options,
    runTokscale: async () => native([row('A', input)]),
    runGraph: async () => {
      const value = graph([row('A', input)], partial ? new Date(now.getTime() + 1000) : now);
      if (partial) value.sourceUsage.scopes[0].readStatus = 'partial';
      return value;
    }, onSourceArchiveComputed: value => { projection = value; },
    dailyHistoryArchiveOptions: { ...f.options.dailyHistoryArchiveOptions,
      writeJsonAtomic: (file, value) => {
        writes++;
        if (failWrite) throw Object.assign(new Error('read-only disk'), { code: 'EROFS' });
        fs.writeFileSync(file, JSON.stringify(value));
      } } };
  await collectUsageOnce(options);
  input = 15; partial = true; failWrite = true;
  await collectUsageOnce(options);
  assert.equal(projection.scopes[0].blockNativeWatch, true);
  input = 45; partial = false;
  const before = writes;
  await collectUsageOnce({ ...options, sourceArchiveSnapshot: projection });
  assert.ok(writes > before, 'revalidating identical accounting must attempt its commit');
  assert.equal(projection.scopes[0].blockNativeWatch, true);
  failWrite = false;
  const beforeDisabled = writes;
  await collectUsageOnce({ ...options, sourceArchiveSnapshot: projection, dailyHistoryArchiveWriteEnabled: false });
  assert.equal(writes, beforeDisabled);
  assert.equal(projection.scopes[0].blockNativeWatch, true, 'a disabled writer cannot release the rejection lock');
  await collectUsageOnce({ ...options, sourceArchiveSnapshot: projection });
  assert.notEqual(projection.scopes[0].blockNativeWatch, true);
  input = 50;
  const watch = await collectUsageOnce({ ...options, includeHistory: false, sourceArchiveSnapshot: projection });
  assert.equal(watch.allTime.totalTokens, 50);
});

test('restart with a locked disk scope requires a successful commit even without a prior snapshot', async t => {
  const f = fixture(t);
  let projection;
  const options = { ...f.options, runTokscale: async () => native([row('A', 45)]),
    runGraph: async () => graph([row('A', 45)]),
    onSourceArchiveComputed: value => { projection = value; } };
  await collectUsageOnce(options);
  await collectUsageOnce({ ...options, sourceArchiveSnapshot: undefined,
    runGraph: async () => { throw new Error('offline graph unavailable'); } });
  assert.equal(projection.scopes[0].blockNativeWatch, true);
  const committed = fs.readFileSync(f.options.dailyHistoryArchiveOptions.path);
  let writable = false, input = 45;
  const updates = [], scans = [];
  const runtime = startCollector({ ...options, includeHistory: undefined,
    watchEnabled: false, sessionActivityPolling: false, anchorPersistenceEnabled: false, intervalMs: 3600000,
    dailyHistoryArchiveWriteEnabled: () => writable,
    runTokscale: async ({ flags }) => { scans.push(flags); return native([row('A', input)]); },
    onUpdate: value => updates.push(value) });
  try {
    await runtime.whenIdle();
    assert.equal(updates.at(-1).allTime.totalTokens, 45);
    assert.equal(JSON.parse(fs.readFileSync(f.options.dailyHistoryArchiveOptions.path)).sourceLedger.scopes.codex.blockNativeWatch, true);
    assert.deepEqual(fs.readFileSync(f.options.dailyHistoryArchiveOptions.path), committed);
    input = 15; scans.length = 0;
    await runtime.tick('watch:fixture', { todayOnly: true });
    assert.deepEqual(scans, [['--today']]);
    assert.equal(updates.at(-1).allTime.totalTokens, 45);
    writable = true; input = 45;
    await runtime.tick('manual', { forceHistory: true });
    assert.notEqual(JSON.parse(fs.readFileSync(f.options.dailyHistoryArchiveOptions.path)).sourceLedger.scopes.codex.blockNativeWatch, true);
    input = 50; scans.length = 0;
    await runtime.tick('watch:fixture', { todayOnly: true });
    assert.deepEqual(scans, [['--today']]);
    assert.equal(updates.at(-1).allTime.totalTokens, 50);
  } finally { runtime.stop(); await runtime.whenIdle(); }
});

test('a locked fresh disk reread also requires a commit before releasing a scope', () => {
  const archive = captureDailyHistoryArchive({}, graph([row('A', 45)]),
    { todayKey: day(now), timeZone: zone, sessionUsageArchive: { version: 1, sessions: {} } });
  const locked = structuredClone(archive);
  locked.sourceLedger.scopes.codex.blockNativeWatch = true;
  let reads = 0;
  const result = retainDailyHistory(graph([row('A', 20)], new Date(now.getTime() + 1000)), {
    todayKey: day(now), timeZone: zone, sessionUsageArchive: { version: 1, sessions: {} },
    sourceArchiveSnapshot: graphFromDailyHistoryArchive([], archive, { timeZone: zone }).sourceUsage,
    readJson: () => ++reads === 1 ? structuredClone(archive) : structuredClone(locked),
    writeEnabled: () => reads < 2,
    writeJsonAtomic: () => assert.fail('the guard disables writes after the fresh reread')
  });
  assert.equal(reads, 2);
  assert.equal(result.sourceUsage.scopes[0].blockNativeWatch, true);
  const summary = periods([row('A', 15)]);
  applySourceDailyUsage(summary, result.sourceUsage, { todayKey: day(now), timeZone: zone, replaceLive: false });
  assert.equal(summary.allTime.totalTokens, 45, 'retain the latest committed accounting, not the uncommitted20');
});

test('a healthy collector timeout keeps its native watch growth without granting graph replacement', async t => {
  const f = fixture(t);
  let clock = now, input = 45, unavailable = false;
  const updates = [], scans = [];
  const runtime = startCollector({ ...f.options, now: () => clock, includeHistory: undefined,
    watchEnabled: false, sessionActivityPolling: false, anchorPersistenceEnabled: false, intervalMs: 3600000,
    runTokscale: async ({ flags }) => { scans.push(flags); return native([row('A', input)]); },
    runGraph: async () => {
      if (unavailable) throw new Error('offline graph unavailable');
      return graph([row('A', input)], clock);
    }, onUpdate: value => updates.push(value) });
  try {
    await runtime.whenIdle();
    const committed = fs.readFileSync(f.options.dailyHistoryArchiveOptions.path);
    unavailable = true;
    for (const growth of [50, 55]) {
      clock = new Date(clock.getTime() + 1000); input = growth;
      await runtime.tick('manual', { forceHistory: true });
      assert.equal(updates.at(-1).allTime.totalTokens, 45, 'timeout supplies no replacement authority');
      assert.deepEqual(fs.readFileSync(f.options.dailyHistoryArchiveOptions.path), committed);
      scans.length = 0;
      await runtime.tick('watch:fixture', { todayOnly: true });
      assert.deepEqual(scans, [['--today']]);
      assert.equal(updates.at(-1).allTime.totalTokens, growth, 'previous healthy scope keeps watch eligibility');
    }
    unavailable = false; clock = new Date(clock.getTime() + 1000); input = 15;
    await runtime.tick('manual', { forceHistory: true });
    assert.equal(updates.at(-1).allTime.totalTokens, 15);
    input = 20;
    await runtime.tick('watch:fixture', { todayOnly: true });
    assert.equal(updates.at(-1).allTime.totalTokens, 20);
  } finally { runtime.stop(); await runtime.whenIdle(); }
});

for (const changed of ['accepted revision', 'observation frontier']) test(`prior healthy snapshot cannot bypass a newer disk ${changed}`, () => {
  const options = { todayKey: day(now), timeZone: zone, sessionUsageArchive: { version: 1, sessions: {} } };
  const archive = captureDailyHistoryArchive({}, graph([row('A', 45)]), options);
  const previous = graphFromDailyHistoryArchive([], archive, options).sourceUsage;
  const clock = new Date(now.getTime() + 1000);
  const latest = captureDailyHistoryArchive(archive, changed === 'accepted revision' ? graph([row('A', 20)], clock)
    : { contributions: [], meta: { generatedAt: clock.toISOString() } }, options);
  assert.notEqual(latest.sourceLedger.scopes.codex.blockNativeWatch, true);
  const result = retainDailyHistory([], { ...options, readJson: () => structuredClone(latest),
    sourceArchiveSnapshot: previous, sourceGraphUnavailable: true, writeEnabled: false });
  assert.equal(result.sourceUsage.scopes[0].blockNativeWatch, true);
  const output = periods([row('A', 15)]);
  applySourceDailyUsage(output, result.sourceUsage, { ...options, replaceLive: false });
  assert.equal(output.allTime.totalTokens, changed === 'accepted revision' ? 20 : 45);
});
