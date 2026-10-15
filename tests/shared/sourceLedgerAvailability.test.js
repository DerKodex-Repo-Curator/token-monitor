'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectUsageOnce, localTodayKey } = require('../../src/shared/collector');
const { extractUsageFromTokscale, mergePeriods } = require('../../src/shared/usage');
const { captureDailyHistoryArchive, captureLiveDailyHistory, graphFromDailyHistoryArchive } = require('../../src/shared/dailyHistoryArchive');
const { applySourceDailyUsage } = require('../../src/shared/usage/sourceDailyUsage');
const { captureSessionUsageArchive, applySessionUsageArchive, isSessionUsageArchiveEvidence } = require('../../src/shared/usage/sessionUsageArchive');
const { serializeSyncPayload } = require('../../src/shared/syncPayload');
const { createSessionUsageArchiveStore } = require('../../src/shared/usage/sessionUsageArchiveStore');

const now = new Date(2026, 9, 15, 12);
const yesterday = new Date(2026, 9, 14, 12);
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const day = clock => localTodayKey(clock, zone);
const row = (client, sessionId, input, clock = now) => ({ client, sessionId, input, clock, model: 'model', cost: input / 100 });
const native = rows => ({ entries: rows.map(({ clock: _clock, ...value }) => value) });
const period = rows => extractUsageFromTokscale(native(rows));
const periods = rows => Object.fromEntries(['today', 'month', 'allTime'].map(name => [name,
  period(name === 'today' ? rows.filter(value => day(value.clock) === day(now)) : rows)]));
function graph(rows, client = 'codex', clock = now, status = 'complete') {
  return { contributions: rows.map(value => ({ date: day(value.clock), clients: [{ client: value.client,
    modelId: value.model, providerId: 'provider', cost: value.cost, messages: 1,
    tokens: { input: value.input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }] })),
    sourceUsage: { version: 2, eventIdentityVersion: 2, fullHistory: true, capturedAt: clock.toISOString(),
      bucketTimezone: zone, replacementClients: [client], partialClients: [], rowsWithoutIdentity: {},
      scopes: [{ id: client, clients: [client], readStatus: status, identityStatus: status === 'unknown' ? 'unresolved' : 'exact' }],
      sessions: rows.map(value => ({ client: value.client, sessionId: value.sessionId, scopeId: client,
        events: [{ id: `event:${value.sessionId}:${day(value.clock)}`, contributions: [{ timestamp: value.clock.getTime(),
          modelId: value.model, providerId: 'provider', cost: value.cost, messages: 1,
          tokens: { input: value.input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }] }] })) } };
}
function fixture(t, clients = 'codex') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'source-availability-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, options: { clients, deviceId: 'availability', allTimeSince: '2026-01-01', now, homeDir: home,
    env: {}, osInfo: {}, projectsEnabled: false, wslScanEnabled: false, codexLocalUsageEnabled: false,
    includeHistory: true, dailyHistoryArchiveEnabled: true, sessionUsageArchive: { version: 1, sessions: {} },
    dailyHistoryArchiveOptions: { path: path.join(home, 'daily.json') },
    sessionMetadataDeps: { resolveSessionMetadata: () => null },
    runTokscale: async () => ({ entries: [] }), runGraph: async () => { throw new Error('fixture graph must be injected'); } } };
}

test('an empty unknown-health source cannot acquire an existing client history or freeze later usage', async t => {
  const f = fixture(t, 'claude');
  const old = row('claude', 'old', 100, yesterday);
  const releasedGraph = graph([old], 'claude', yesterday);
  delete releasedGraph.sourceUsage;
  fs.writeFileSync(f.options.dailyHistoryArchiveOptions.path, JSON.stringify(captureDailyHistoryArchive({}, releasedGraph)));
  const generic = captureSessionUsageArchive({}, { updatedAt: yesterday.toISOString(), ...periods([old]) }, yesterday);
  const empty = await collectUsageOnce({ ...f.options, sessionUsageArchive: generic,
    runGraph: async () => graph([], 'claude', now, 'unknown') });
  assert.deepEqual(empty.sessionArchiveSource.ownedClients, []);
  assert.equal(empty.history.summary.totalTokens, 100);
  const fresh = row('claude', 'new', 5);
  const later = new Date(now.getTime() + 1000);
  const next = await collectUsageOnce({ ...f.options, now: later, sessionUsageArchive: generic,
    runTokscale: async () => native([fresh]), runGraph: async () => graph([fresh], 'claude', later, 'unknown') });
  assert.deepEqual(next.sessionArchiveSource.ownedClients, []);
  assert.equal(next.today.totalTokens, 5);
  assert.equal(next.history.summary.totalTokens, 105);
  assert.equal(applySessionUsageArchive(next, generic, { now }).allTime.totalTokens, 105);
});

test('a legacy accounting boundary retains fresh native context and turn metadata without changing its counters', () => {
  const old = row('codex', 'old', 100, yesterday), fresh = row('codex', 'live', 5);
  const released = graph([old], 'codex', yesterday); delete released.sourceUsage;
  const calendar = { todayKey: day(now), timeZone: zone,
    sessionUsageArchive: captureSessionUsageArchive({}, { updatedAt: yesterday.toISOString(),
      today: period([old]), month: period([old]), allTime: period([old]) }, yesterday) };
  let archive = captureDailyHistoryArchive({}, released, calendar);
  archive = captureDailyHistoryArchive(archive, graph([fresh]), { ...calendar, nativePeriods: periods([fresh]) });
  const projection = graphFromDailyHistoryArchive([], archive, calendar).sourceUsage;
  assert.equal(projection.scopes[0].mode, 'legacy');
  const summary = periods([fresh]);
  for (const name of ['today', 'month', 'allTime']) Object.assign(summary[name].sessions['codex:live'], {
    contextTokens: 200, contextWindow: 1000, turnEnded: false, waitingForInput: true,
    promptCache: { observedAt: now.toISOString(), ttlSeconds: 1800 }, lastUsedAt: now.toISOString() });
  applySourceDailyUsage(summary, projection, { ...calendar, nativePeriods: structuredClone(summary) });
  assert.equal(summary.allTime.totalTokens, 105);
  const live = summary.today.sessions['codex:live'];
  assert.equal(live.contextTokens, 200);
  assert.equal(live.contextWindow, 1000);
  assert.equal(live.waitingForInput, true);
  assert.equal(live.turnEnded, false);
  assert.equal(live.promptCache.ttlSeconds, 1800);
  assert.equal(live.sourceState, 'present');
  const inactive = periods([]);
  applySourceDailyUsage(inactive, projection, { ...calendar, nativePeriods: structuredClone(inactive) });
  assert.equal(inactive.allTime.totalTokens, 105);
  assert.equal(inactive.today.sessions['codex:live'].sourceState, 'unknown');
  assert.equal(inactive.today.sessions['codex:live'].contextTokens, 0);
  assert.equal(inactive.today.sessions['codex:live'].promptCache, undefined);
});

test('host source ownership leaves distinct WSL session counters in the generic archive through SQLite reload', async t => {
  const f = fixture(t);
  const host = row('codex', 'host', 100), wsl = row('codex', 'wsl-only', 9);
  let wslPresent = true;
  let store = createSessionUsageArchiveStore({ databasePath: path.join(f.home, 'sessions.sqlite'), path: path.join(f.home, 'sessions.json') });
  try {
    const options = { ...f.options, wslScanEnabled: true, runTokscale: async () => native([host]),
      runGraph: async () => graph([host]),
      collectWslUsage: async () => ({ detected: ['codex'], bundle: periods(wslPresent ? [wsl] : []) }) };
    const first = await collectUsageOnce(options);
    assert.equal(first.allTime.totalTokens, 109);
    assert.equal(serializeSyncPayload(first).body.includes('wslKeys'), false);
    store.capture(first, now);
    assert.equal(store.readMigrationEvidence().sessions['codex:wsl-only'].periods.allTime.totalTokens, 9);
    assert.equal(store.readMigrationEvidence().sessions['codex:wsl-only'].accountingSource, 'wsl');
    store.close();
    store = createSessionUsageArchiveStore({ databasePath: path.join(f.home, 'sessions.sqlite'), path: path.join(f.home, 'sessions.json') });
    wslPresent = false;
    const next = await collectUsageOnce({ ...options, now: new Date(now.getTime() + 1000),
      runGraph: async () => graph([host], 'codex', new Date(now.getTime() + 1000)) });
    store.capture(next, now);
    assert.equal(store.readMigrationEvidence().sessions['codex:wsl-only'].accountingSource, 'wsl');
    assert.equal(store.readMigrationEvidence().sessions['codex:wsl-only'].periods.allTime.totalTokens, 9);
    const visible = applySessionUsageArchive(next, store.readMigrationEvidence(), { now });
    assert.equal(visible.allTime.totalTokens, 109);
    assert.equal(visible.allTime.sessions['codex:wsl-only'].totalTokens, 9);
    assert.equal(visible.allTime.sessions['codex:host'].totalTokens, 100);
  } finally { store.close(); }
});

test('WSL provenance persists when an unchanged warm row is captured, and exact host ownership still wins a key collision', t => {
  const f = fixture(t);
  const options = { databasePath: path.join(f.home, 'warm.sqlite'), path: path.join(f.home, 'warm.json') };
  let store = createSessionUsageArchiveStore(options);
  const summary = { updatedAt: now.toISOString(), ...periods([row('codex', 'shared', 9)]),
    sessionArchiveSource: { fullScan: false, paths: {} } };
  try {
    store.capture(summary, now);
    summary.sessionArchiveSource = { ...summary.sessionArchiveSource, wslKeys: ['codex:shared'],
      ownedClients: ['codex'], boundaryCheckedClients: ['codex'] };
    store.capture(summary, now);
    store.close(); store = createSessionUsageArchiveStore(options);
    const evidence = store.readMigrationEvidence();
    assert.equal(evidence.sessions['codex:shared'].accountingSource, 'wsl');
    assert.equal(isSessionUsageArchiveEvidence(evidence), true);
    const zeroHost = { updatedAt: now.toISOString(), ...periods([row('codex', 'shared', 0)]),
      sessionArchiveSource: { ...summary.sessionArchiveSource, managedKeys: ['codex:shared'] } };
    store.capture(zeroHost, now);
    assert.equal(store.readMigrationEvidence().sessions['codex:shared'].periods.allTime.totalTokens, 0);
    assert.equal(store.readMigrationEvidence().sessions['codex:shared'].accountingSource, undefined);
    assert.equal(applySessionUsageArchive(zeroHost, store.readMigrationEvidence(), { now }).allTime.totalTokens, 0);
  } finally { store.close(); }
});

test('first import separates currently observed WSL sessions from unmarked released generic counters', async t => {
  const f = fixture(t);
  const host = row('codex', 'host', 100);
  let wslRows = [row('codex', 'wsl-released', 9)];
  const store = createSessionUsageArchiveStore({ databasePath: path.join(f.home, 'import.sqlite'), path: path.join(f.home, 'import.json') });
  try {
    store.capture({ updatedAt: now.toISOString(), ...periods([host, ...wslRows]) }, now);
    assert.equal(store.readMigrationEvidence().sessions['codex:wsl-released'].accountingSource, undefined);
    const collect = seconds => {
      const clock = new Date(now.getTime() + seconds * 1000);
      return collectUsageOnce({ ...f.options, now: clock, wslScanEnabled: true, sessionUsageArchive: undefined,
        getSessionUsageArchive: () => store.readMigrationEvidence(), runTokscale: async () => native([host]),
        runGraph: async () => graph([host], 'codex', clock),
        collectWslUsage: async () => ({ detected: ['codex'], bundle: periods(wslRows) }) });
    };
    const first = await collect(1);
    assert.equal(first.allTime.totalTokens, 109);
    store.capture(first, new Date(now.getTime() + 1000));
    assert.equal(store.readMigrationEvidence().sessions['codex:wsl-released'].accountingSource, 'wsl');
    const ledger = JSON.parse(fs.readFileSync(f.options.dailyHistoryArchiveOptions.path, 'utf8')).sourceLedger;
    assert.equal(ledger.scopes.codex.mode, 'legacy');
    assert.equal(ledger.scopes.codex.sessions['codex:wsl-released'], undefined);
    wslRows = [row('codex', 'wsl-released', 12)];
    const growth = await collect(2);
    assert.equal(growth.allTime.totalTokens, 112);
    store.capture(growth, new Date(now.getTime() + 2000));
    wslRows = [];
    const offline = await collect(3);
    store.capture(offline, new Date(now.getTime() + 3000));
    const visible = applySessionUsageArchive(offline, store.readMigrationEvidence(), { now });
    assert.equal(visible.allTime.totalTokens, 112);
    assert.equal(visible.allTime.sessions['codex:wsl-released'].totalTokens, 12);
  } finally { store.close(); }
});

function offlineWslImport(t, released = [row('codex', 'wsl-old', 9)]) {
  const f = fixture(t);
  const host = row('codex', 'host', 100);
  const store = createSessionUsageArchiveStore({ databasePath: path.join(f.home, 'offline-import.sqlite'), path: path.join(f.home, 'offline-import.json') });
  store.capture({ updatedAt: now.toISOString(), ...periods([host, ...released]) }, now);
  let clock = 0, sourceUsage, anchor, frozenWsl;
  const collect = async ({ wslRows = [], hostTokens = 100, status = 'complete', watch = false } = {}) => {
    const at = new Date(now.getTime() + ++clock * 1000);
    const nativeRows = [row('codex', 'host', hostTokens)];
    const result = await collectUsageOnce({ ...f.options, now: at, wslScanEnabled: true, sessionUsageArchive: undefined,
      getSessionUsageArchive: () => store.readMigrationEvidence(), sourceArchiveSnapshot: sourceUsage,
      includeHistory: !watch, todayOnlyAnchor: watch ? anchor : undefined, wslAnchor: watch ? frozenWsl : undefined,
      runTokscale: async ({ flags }) => { if (watch) assert.deepEqual(flags, ['--today']); return native(nativeRows); },
      runGraph: async () => { assert.equal(watch, false); return graph(nativeRows, 'codex', at, status); },
      onSourceArchiveComputed: value => { sourceUsage = value; },
      onAnchorComputed: value => { anchor = { ...value.windowsPeriods, dateKey: value.dateKey, timeZone: value.timeZone,
        todayPartitions: value.todayPartitions, nativeRawPresence: value.nativeRawPresence }; },
      collectWslUsage: async () => { assert.equal(watch, false); frozenWsl = periods(wslRows);
        return { detected: ['codex'], bundle: frozenWsl }; } });
    store.capture(result, at);
    return { result: applySessionUsageArchive(result, store.readMigrationEvidence(), { now: at }),
      sourceUsage, anchor, disk: JSON.parse(fs.readFileSync(f.options.dailyHistoryArchiveOptions.path, 'utf8')) };
  };
  return { store, collect };
}

test('an already absorbed WSL identity advances one whole legacy observation and persists through absence', async t => {
  const f = offlineWslImport(t);
  try {
    assert.equal((await f.collect()).result.allTime.totalTokens, 109);
    const returns = await f.collect({ wslRows: [row('codex', 'wsl-old', 12)] });
    assert.equal(returns.result.allTime.totalTokens, 112);
    assert.equal(returns.result.allTime.sessions['codex:wsl-old'].totalTokens, 12);
    assert.equal(returns.anchor.allTime.totalTokens, 100, 'native anchor remains host-only');
    assert.equal(returns.disk.sourceLedger.scopes.codex.legacyDays[day(now)].sessionAllocation['codex:wsl-old'].totalTokens, 9,
      'new WSL lifetime usage does not invent timestamped daily contributions');
    assert.equal((await f.collect()).result.allTime.totalTokens, 112);
    assert.equal((await f.collect({ wslRows: [row('codex', 'wsl-old', 15)] })).result.allTime.totalTokens, 115);
  } finally { f.store.close(); }
});

test('a partially returning legacy WSL inventory retains the whole floor instead of adding its visible member twice', async t => {
  const f = offlineWslImport(t, [row('codex', 'wsl-old', 9), row('codex', 'wsl-offline', 50)]);
  try {
    assert.equal((await f.collect()).result.allTime.totalTokens, 159);
    const returns = await f.collect({ wslRows: [row('codex', 'wsl-old', 12)] });
    assert.equal(returns.result.allTime.totalTokens, 159);
    assert.equal(returns.result.allTime.sessions['codex:wsl-old'].totalTokens, 9);
    assert.equal(returns.result.allTime.sessions['codex:wsl-offline'].totalTokens, 50);
  } finally { f.store.close(); }
});

test('anchored watch uses frozen absorbed WSL usage while keeping native growth and complete recovery', async t => {
  const f = offlineWslImport(t);
  try {
    await f.collect();
    await f.collect({ wslRows: [row('codex', 'wsl-old', 12)] });
    const watch = await f.collect({ watch: true, hostTokens: 105 });
    assert.equal(watch.result.allTime.totalTokens, 117);
    assert.equal(watch.result.allTime.sessions['codex:wsl-old'].totalTokens, 12);
    const full = await f.collect({ hostTokens: 105, wslRows: [row('codex', 'wsl-old', 12)] });
    assert.equal(full.result.allTime.totalTokens, 117);
    assert.equal(full.anchor.allTime.totalTokens, 105);
  } finally { f.store.close(); }
});

test('a partial host graph cannot advance absorbed WSL usage or leak it into subsequent anchored watch', async t => {
  const f = offlineWslImport(t);
  try {
    await f.collect();
    const rejected = await f.collect({ status: 'partial', wslRows: [row('codex', 'wsl-old', 12)] });
    assert.equal(rejected.result.allTime.totalTokens, 109);
    assert.equal(rejected.sourceUsage.scopes[0].blockNativeWatch, true);
    assert.equal((await f.collect({ watch: true, hostTokens: 105 })).result.allTime.totalTokens, 109);
    assert.equal((await f.collect({ hostTokens: 105, wslRows: [row('codex', 'wsl-old', 12)] })).result.allTime.totalTokens, 117);
  } finally { f.store.close(); }
});

test('a separate new WSL identity remains generic when an older WSL identity is already absorbed', async t => {
  const f = offlineWslImport(t);
  try {
    await f.collect();
    const fresh = await f.collect({ wslRows: [row('codex', 'wsl-old', 12), row('codex', 'wsl-new', 7)] });
    assert.equal(fresh.result.allTime.totalTokens, 119);
    assert.equal(f.store.readMigrationEvidence().sessions['codex:wsl-new'].accountingSource, 'wsl');
    assert.equal(f.store.readMigrationEvidence().sessions['codex:wsl-new'].periods.allTime.totalTokens, 7);
    assert.equal((await f.collect()).result.allTime.totalTokens, 119);
  } finally { f.store.close(); }
});

test('removing an absorbed multi-model WSL row conserves counters and leaves ambiguous model components unavailable', async t => {
  const f = offlineWslImport(t, [row('codex', 'wsl-old', 30)]);
  try {
    await f.collect();
    const result = (await f.collect({ wslRows: [
      { ...row('codex', 'wsl-old', 7), model: 'model-a', output: 3 },
      { ...row('codex', 'wsl-old', 14), model: 'model-b', output: 6, cacheRead: 3 },
      { ...row('codex', 'wsl-new', 3), model: 'model-b', output: 4 }
    ] })).result.allTime;
    assert.equal(result.totalTokens, 140);
    assert.equal(Object.values(result.sessions).reduce((sum, value) => sum + value.totalTokens, 0), 140);
    assert.equal(result.outputTokens, 13);
    assert.equal(result.cacheReadTokens, 3);
    assert.equal(result.models['model-b'], 30);
    assert.equal(result.capabilities.tokenComponents, false);
    for (const field of ['modelOutputs', 'modelCacheReads', 'modelCacheWrites', 'modelUnclassifiedTokens']) {
      for (const [model, value] of Object.entries(result[field])) assert.ok(value >= 0 && value <= (result.models[model] || 0));
    }
    assert.ok(Math.abs(result.costUsd - 1.24) < 1e-12);
  } finally { f.store.close(); }
});

test('absorbed MiMo WSL keys use the same canonical client as raw CLI/Desktop export aliases', () => {
  const oldHost = row('mimo', 'host', 100), oldWsl = row('mimo', 'wsl-old', 9);
  const archive = captureSessionUsageArchive({}, { updatedAt: now.toISOString(), ...periods([oldHost, oldWsl]) }, now);
  const host = row('micode', 'host', 100);
  const source = clock => {
    const value = graph([host], 'micode', clock);
    value.sourceUsage.scopes[0].clients = ['micode', 'micode-desktop'];
    value.sourceUsage.replacementClients = ['micode', 'micode-desktop'];
    return value;
  };
  const options = { todayKey: day(now), timeZone: zone, sessionUsageArchive: archive, nativePeriods: periods([oldHost]) };
  let daily = captureDailyHistoryArchive({}, source(now), options);
  const wsl = periods([row('micode-desktop', 'wsl-old', 12)]);
  daily = captureDailyHistoryArchive(daily, source(new Date(now.getTime() + 1000)), {
    ...options, wslPeriods: wsl, wslSessionKeys: ['mimo:wsl-old'] });
  const projection = graphFromDailyHistoryArchive([], daily, options).sourceUsage;
  const summary = { ...periods([oldHost, row('mimo', 'wsl-old', 12)]), sessionArchiveSource: { wslKeys: ['mimo:wsl-old'] } };
  applySourceDailyUsage(summary, projection, { ...options, clients: 'mimo', wslPeriods: wsl,
    wslSessionKeys: ['mimo:wsl-old'], supplementalPeriods: wsl });
  assert.equal(summary.allTime.totalTokens, 112);
  assert.equal(summary.allTime.sessions['mimo:wsl-old'].totalTokens, 12);
});

test('an absorbed WSL key uses its current Today window without allocating lifetime growth to a new History day', () => {
  const host = row('codex', 'host', 100), oldWsl = row('codex', 'wsl-old', 9);
  const archive = captureSessionUsageArchive({}, { updatedAt: now.toISOString(), ...periods([host, oldWsl]) }, now);
  const options = { todayKey: day(now), timeZone: zone, sessionUsageArchive: archive, nativePeriods: periods([host]) };
  let daily = captureDailyHistoryArchive({}, graph([host]), options);
  const tomorrow = new Date(2026, 9, 16, 12);
  const wslToday = row('codex', 'wsl-old', 3, tomorrow), wslTotal = row('codex', 'wsl-old', 12, tomorrow);
  const nativePeriods = { today: period([]), month: period([host]), allTime: period([host]) };
  const wslPeriods = { today: period([wslToday]), month: period([wslTotal]), allTime: period([wslTotal]) };
  const nextOptions = { ...options, todayKey: day(tomorrow), nativePeriods, wslPeriods, wslSessionKeys: ['codex:wsl-old'] };
  daily = captureDailyHistoryArchive(daily, graph([host], 'codex', tomorrow), nextOptions);
  const projection = graphFromDailyHistoryArchive([], daily, nextOptions).sourceUsage;
  const summary = { today: period([wslToday]), month: period([host, wslTotal]), allTime: period([host, wslTotal]) };
  applySourceDailyUsage(summary, projection, nextOptions);
  assert.equal(summary.today.totalTokens, 3);
  assert.equal(summary.month.totalTokens, 112);
  assert.equal(summary.allTime.totalTokens, 112);
  assert.equal(daily.sourceLedger.scopes.codex.legacyDays[day(tomorrow)], undefined);
  assert.equal(nativePeriods.today.totalTokens, 0);
  assert.equal(nativePeriods.allTime.totalTokens, 100);
});

function mixedAllocationWslImport(t) {
  const f = fixture(t);
  const oldHost = row('codex', 'old-host', 100), oldWsl = row('codex', 'wsl-old', 9);
  const released = [oldHost, oldWsl];
  const seed = captureLiveDailyHistory({}, period(released), { todayKey: day(now) });
  assert.equal(seed.liveDays[day(now)].sessionAllocation, undefined);
  assert.equal(seed.liveDays[day(now)].componentSummary.tokenComponentsAvailable, true);
  fs.writeFileSync(f.options.dailyHistoryArchiveOptions.path, JSON.stringify(seed));
  const storeOptions = { databasePath: path.join(f.home, 'mixed.sqlite'), path: path.join(f.home, 'mixed.json') };
  let store = createSessionUsageArchiveStore(storeOptions);
  store.capture({ updatedAt: now.toISOString(), ...periods(released) }, now);
  const tomorrow = new Date(2026, 9, 16, 12);
  const fresh = row('codex', 'new-host', 5, tomorrow);
  let tick = 0, snapshot, anchor, frozenWsl;
  const collect = async ({ returning = false, status = 'complete', watch = false } = {}) => {
    const at = new Date(tomorrow.getTime() + ++tick * 1000);
    const emptyWsl = () => Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, period([])]));
    const bundle = returning ? { today: period([row('codex', 'wsl-old', 3, tomorrow)]),
      month: period([row('codex', 'wsl-old', 12, tomorrow)]), allTime: period([row('codex', 'wsl-old', 12, tomorrow)]) } : emptyWsl();
    const raw = await collectUsageOnce({ ...f.options, now: at, wslScanEnabled: true, sessionUsageArchive: undefined,
      getSessionUsageArchive: () => store.readMigrationEvidence(), sourceArchiveSnapshot: snapshot,
      includeHistory: !watch, todayOnlyAnchor: watch ? anchor : undefined, wslAnchor: watch ? frozenWsl : undefined,
      runTokscale: async ({ flags }) => { if (watch) assert.deepEqual(flags, ['--today']); return native([fresh]); },
      runGraph: async () => { assert.equal(watch, false); return graph([fresh], 'codex', at, status); },
      onSourceArchiveComputed: value => { snapshot = value; },
      onAnchorComputed: value => { anchor = { ...value.windowsPeriods, dateKey: value.dateKey, timeZone: value.timeZone,
        todayPartitions: value.todayPartitions, nativeRawPresence: value.nativeRawPresence }; },
      collectWslUsage: async () => { assert.equal(watch, false); frozenWsl = bundle;
        return { detected: ['codex'], bundle }; } });
    store.capture(raw, at);
    const result = applySessionUsageArchive(raw, store.readMigrationEvidence(), { now: at });
    return { result, snapshot, anchor, disk: JSON.parse(fs.readFileSync(f.options.dailyHistoryArchiveOptions.path, 'utf8')) };
  };
  return { collect, close: () => store.close(), reload: () => { store.close(); store = createSessionUsageArchiveStore(storeOptions);
    snapshot = undefined; anchor = undefined; frozenWsl = undefined; } };
}

for (const route of ['healthy', 'partial', 'watch', 'partial-watch', 'reload']) {
  test(`mixed allocated and unallocated legacy days cannot replay an absorbed WSL row on ${route}`, async t => {
    const f = mixedAllocationWslImport(t);
    try {
      const initial = await f.collect();
      assert.equal(initial.result.allTime.totalTokens, 114);
      assert.equal(initial.result.history.summary.totalTokens, 114);
      assert.deepEqual(Object.keys(initial.result.allTime.sessions), ['codex:new-host']);
      const legacy = initial.disk.sourceLedger.scopes.codex;
      assert.equal(legacy.sessions['codex:wsl-old'].sessionId, 'wsl-old');
      assert.equal(legacy.legacyDays[day(now)].sessionAllocation, undefined);
      assert.equal(legacy.legacyDays['2026-10-16'].sessionAllocation['codex:new-host'].totalTokens, 5);
      assert.equal(legacy.legacyPeriods.allTime.period.totalTokens, 109);
      if (route === 'reload') f.reload();
      let current = await f.collect({ returning: true, status: route.startsWith('partial') ? 'partial' : 'complete' });
      if (route.includes('watch')) current = await f.collect({ watch: true });
      assert.equal(current.result.allTime.totalTokens, 114);
      assert.equal(current.result.month.totalTokens, 114);
      assert.equal(current.result.allTime.sessions['codex:wsl-old'], undefined);
      assert.equal(current.anchor.allTime.totalTokens, 5, 'native anchor stays Host-only');
      if (route.startsWith('partial')) assert.equal(current.snapshot.scopes[0].blockNativeWatch, true);
      if (!route.includes('watch')) assert.equal(current.result.history.summary.totalTokens, 114);
      const recovered = await f.collect({ returning: true });
      assert.equal(recovered.result.allTime.totalTokens, 114);
      assert.equal(recovered.snapshot.scopes[0].blockNativeWatch, undefined);
    } finally { f.close(); }
  });
}

for (const status of ['complete', 'partial']) test(`a complete trusted allocation proves an absorbed WSL row is disjoint under a ${status} graph`, async t => {
  const f = offlineWslImport(t);
  try {
    await f.collect();
    const hostOnly = await f.collect({ hostTokens: 150 });
    assert.equal(hostOnly.result.allTime.totalTokens, 150);
    assert.deepEqual(Object.keys(hostOnly.result.allTime.sessions), ['codex:host']);
    const returns = await f.collect({ hostTokens: 5, status, wslRows: [row('codex', 'wsl-old', 12)] });
    assert.equal(returns.result.allTime.totalTokens, 162, 'fully allocated retained Host150 excludes current WSL12');
    assert.equal(returns.result.allTime.sessions['codex:host'].totalTokens, 150);
    assert.equal(returns.result.allTime.sessions['codex:wsl-old'].totalTokens, 12);
  } finally { f.store.close(); }
});

const nativeFragmentCases = [
  { name: 'single-model input', entries: total => [{ model: 'model-a', input: total }] },
  { name: 'multi-model input', entries: total => [{ model: 'model-a', input: total * 3 / 5 }, { model: 'model-b', input: total * 2 / 5 }] },
  { name: 'single-model output', entries: total => [{ model: 'model-a', input: total * 4 / 5, output: total / 5 }] },
  { name: 'single-model caches and output', entries: total => [{ model: 'model-a', input: total * 2 / 5, output: total / 5,
    cacheRead: total / 5, cacheWrite: total / 5 }] },
  { name: 'multi-model output', entries: total => [{ model: 'model-a', input: total * 2 / 5, output: total / 5 },
    { model: 'model-b', input: total * 2 / 5 }] }
];
for (const sample of nativeFragmentCases) test(`cross-day allocated legacy fragments keep disjoint frozen WSL usage through ${sample.name} watch and full scans`, async t => {
  const f = fixture(t);
  const storeOptions = { databasePath: path.join(f.home, 'provenance.sqlite'), path: path.join(f.home, 'provenance.json') };
  let store = createSessionUsageArchiveStore(storeOptions);
  try {
    const oldWsl = row('codex', 'wsl-old', 9, yesterday), oldHost = row('codex', 'old-host', 100);
    const oldWslPeriod = period([oldWsl]);
    store.capture({ updatedAt: yesterday.toISOString(), today: oldWslPeriod, month: oldWslPeriod, allTime: oldWslPeriod }, yesterday);
    store.capture({ updatedAt: now.toISOString(), ...periods([oldHost]) }, now);
    const released = store.readMigrationEvidence();
    assert.equal(released.sessions['codex:wsl-old'].periods.today, undefined, 'normal daily pruning removes only the expired WSL Today');
    assert.equal(released.sessions['codex:wsl-old'].periods.allTime.totalTokens, 9);
    assert.equal(released.sessions['codex:old-host'].periods.today.totalTokens, 100);
    const tomorrow = new Date(2026, 9, 16, 12);
    let tick = 0, snapshot, anchor, frozenWsl;
    const collect = async ({ returning = false, watch = false, hostTokens = 5 } = {}) => {
      const at = new Date(tomorrow.getTime() + ++tick * 1000);
      const entries = sample.entries(hostTokens).map(value => ({ ...row('codex', 'new-host', value.input, tomorrow), ...value,
        cost: (value.input + (value.output || 0) + (value.cacheRead || 0) + (value.cacheWrite || 0)) / 100 }));
      // One inventory row per session, with stable per-model events. Do not
      // manufacture duplicate session rows/IDs when a session uses two models.
      const inputGraph = graph([], 'codex', at);
      for (const entry of entries) {
        const contribution = { timestamp: tomorrow.getTime(), modelId: entry.model, providerId: 'provider', cost: entry.cost,
          messages: 1, tokens: { input: entry.input, output: entry.output || 0, cacheRead: entry.cacheRead || 0,
            cacheWrite: entry.cacheWrite || 0, reasoning: 0 } };
        inputGraph.contributions.push({ date: day(tomorrow), clients: [{ ...contribution, client: 'codex' }] });
        inputGraph.sourceUsage.sessions[0] ||= { client: 'codex', sessionId: 'new-host', scopeId: 'codex', events: [] };
        inputGraph.sourceUsage.sessions[0].events.push({ id: `event:new-host:${entry.model}`, contributions: [contribution] });
      }
      assert.equal(inputGraph.sourceUsage.sessions.length, 1);
      assert.equal(new Set(inputGraph.sourceUsage.sessions[0].events.map(event => event.id)).size, entries.length);
      const bundle = Object.fromEntries(['today', 'month', 'allTime'].map(name => [name,
        period(returning ? [row('codex', 'wsl-old', name === 'today' ? 3 : 12, tomorrow)] : [])]));
      const raw = await collectUsageOnce({ ...f.options, now: at, wslScanEnabled: true, sessionUsageArchive: undefined,
        getSessionUsageArchive: () => store.readMigrationEvidence(), sourceArchiveSnapshot: snapshot,
        includeHistory: !watch, todayOnlyAnchor: watch ? anchor : undefined, wslAnchor: watch ? frozenWsl : undefined,
        runTokscale: async ({ flags }) => { if (watch) assert.deepEqual(flags, ['--today']); return native(entries); },
        runGraph: async () => { assert.equal(watch, false); return inputGraph; },
        onSourceArchiveComputed: value => { snapshot = value; },
        onAnchorComputed: value => { anchor = { ...value.windowsPeriods, dateKey: value.dateKey, timeZone: value.timeZone,
          todayPartitions: value.todayPartitions, nativeRawPresence: value.nativeRawPresence }; },
        collectWslUsage: async () => { assert.equal(watch, false); frozenWsl = bundle;
          return { detected: ['codex'], bundle }; } });
      store.capture(raw, at);
      return applySessionUsageArchive(raw, store.readMigrationEvidence(), { now: at });
    };
    assert.equal((await collect()).allTime.totalTokens, 109);
    assert.equal((await collect({ returning: true })).allTime.totalTokens, 109);
    assert.equal(anchor.allTime.totalTokens, 5);
    if (sample.name === 'multi-model output') {
      const entries = sample.entries(50).map(value => ({ ...row('codex', 'new-host', value.input, tomorrow), ...value,
        cost: (value.input + (value.output || 0)) / 100 }));
      const cases = [
        { name: 'complete native allocation', expected: 162, mutate: () => {} },
        { name: 'explicit unknown native components', expected: 162, mutate: native => {
          native.outputTokens = 0; native.clientOutputs = {}; native.modelOutputs = {};
          native.unclassifiedTokens = 50; native.clientUnclassifiedTokens = { codex: 50 };
          native.modelUnclassifiedTokens = { 'model-a': 30, 'model-b': 20 };
          native.capabilities.tokenComponents = false;
          native.sessions['codex:new-host'].inputTokens = 0; native.sessions['codex:new-host'].outputTokens = 0;
        } },
        { name: 'zero native allocation', expected: 150, mutate: native => { native.sessions = {}; } },
        { name: 'partial native allocation', expected: 150, mutate: native => {
          Object.assign(native.sessions['codex:new-host'], { totalTokens: 30, inputTokens: 20, costUsd: 0.3,
            models: { 'model-a': 30 }, modelCosts: { 'model-a': 0.3 } });
        } },
        { name: 'missing model output evidence', expected: 150, mutate: native => { native.modelOutputs = {}; } },
        { name: 'mismatched model allocation', expected: 150, mutate: native => {
          native.sessions['codex:new-host'].models = { 'model-a': 29, 'model-b': 21 };
        } },
        { name: 'mismatched model costs', expected: 150, mutate: native => { native.modelCosts['model-a'] += 0.1; } },
        { name: 'partition from another observation', expected: 150, mutate: () => {}, stalePartition: true }
      ];
      for (const value of cases) await t.test(value.name, () => {
        const current = period(entries); value.mutate(current);
        const nativePeriods = Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, structuredClone(current)]));
        const summary = structuredClone(nativePeriods);
        const partition = value.stalePartition ? period([row('codex', 'new-host', 5, tomorrow)]) : current;
        applySourceDailyUsage(summary, snapshot, { todayKey: day(tomorrow), timeZone: zone, allTimeSince: '2026-01-01',
          clients: 'codex', replaceLive: false, nativePeriods, nativePartitions: { today: { codex: partition } },
          nativeAnchor: anchor, wslPeriods: frozenWsl, wslSessionKeys: ['codex:wsl-old'], supplementalPeriods: frozenWsl });
        assert.equal(summary.allTime.totalTokens, value.expected);
        assert.equal(summary.allTime.sessions['codex:wsl-old']?.totalTokens, value.expected === 162 ? 12 : undefined);
        if (value.name === 'explicit unknown native components') assert.equal(summary.allTime.unclassifiedTokens, 150);
      });
      const unrelated = period([{ ...row('claude', 'unrelated', 4, tomorrow), model: 'model-a', output: 3 }]);
      const mixedClientNative = mergePeriods(period(entries), unrelated);
      const summary = Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, structuredClone(mixedClientNative)]));
      const nativePeriods = structuredClone(summary);
      applySourceDailyUsage(summary, snapshot, { todayKey: day(tomorrow), timeZone: zone, allTimeSince: '2026-01-01',
        clients: 'codex,claude', replaceLive: false, nativePeriods,
        nativePartitions: { today: { codex: period(entries), claude: unrelated } },
        nativeAnchor: anchor, wslPeriods: frozenWsl, wslSessionKeys: ['codex:wsl-old'], supplementalPeriods: frozenWsl });
      assert.equal(summary.allTime.totalTokens, 169, 'select only the owned native partition and preserve unrelated usage');
      assert.equal(summary.allTime.outputTokens, 13);
      assert.equal(summary.allTime.sessions['codex:new-host'].outputTokens, 10);
      assert.equal(summary.allTime.sessions['claude:unrelated'].outputTokens, 3);
    }
    const watched = await collect({ watch: true, hostTokens: 50 });
    const full = await collect({ returning: true, hostTokens: 50 });
    t.diagnostic(JSON.stringify({ watch: watched.allTime.totalTokens, full: full.allTime.totalTokens,
      watchUnclassified: watched.allTime.unclassifiedTokens, fullUnclassified: full.allTime.unclassifiedTokens }));
    assert.equal(watched.allTime.totalTokens, 162);
    assert.equal(watched.month.totalTokens, 162);
    assert.equal(watched.allTime.unclassifiedTokens, 100, 'retain the old-day unknown and the fresh native input separately');
    assert.equal(watched.allTime.sessions['codex:old-host'].totalTokens, 100);
    assert.equal(watched.allTime.sessions['codex:new-host'].totalTokens, 50);
    assert.equal(watched.allTime.sessions['codex:wsl-old'].totalTokens, 12);
    assert.equal(full.allTime.totalTokens, 162);
    assert.equal(full.allTime.unclassifiedTokens, 100 + sample.entries(50).reduce((sum, entry) => sum + entry.input, 0));
    assert.equal(anchor.allTime.totalTokens, 50, 'native anchors never absorb frozen WSL counters');
    assert.equal(snapshot.scopes[0].blockNativeWatch, undefined);
    store.close(); store = createSessionUsageArchiveStore(storeOptions);
    snapshot = undefined; anchor = undefined; frozenWsl = undefined;
    assert.equal((await collect({ returning: true, hostTokens: 50 })).allTime.totalTokens, 162);
    const reloadedWatch = await collect({ watch: true, hostTokens: 55 });
    assert.equal(reloadedWatch.allTime.totalTokens, 167);
    assert.equal(reloadedWatch.allTime.sessions['codex:wsl-old'].totalTokens, 12);
    assert.equal(reloadedWatch.allTime.unclassifiedTokens, 100);
  } finally { store.close(); }
});
