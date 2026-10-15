'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectUsageOnce, localTodayKey } = require('../../src/shared/collector');
const { extractUsageFromTokscale } = require('../../src/shared/usage');
const { captureSessionUsageArchive, applySessionUsageArchive, isSessionUsageArchiveEvidence,
  normalizeSessionUsageArchive } = require('../../src/shared/usage/sessionUsageArchive');
const { createSessionUsageArchiveStore, readSessionUsageArchiveEvidence } = require('../../src/shared/usage/sessionUsageArchiveStore');
const { createUsageTransform } = require('../../src/shared/usage/usageTransform');
const { retainDailyHistory, readDailyHistoryArchive, graphFromDailyHistoryArchive } = require('../../src/shared/dailyHistoryArchive');
const { applySourceDailyUsage } = require('../../src/shared/usage/sourceDailyUsage');

const now = new Date('2026-10-15T04:43:55.410Z');
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const day = localTodayKey(now, zone);
const native = tokens => ({ entries: [{ client: 'codex', sessionId: 'one', model: 'model', input: tokens, cost: 1 }] });
const periods = tokens => Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, extractUsageFromTokscale(native(tokens))]));
function graph(tokens, at) {
  const contribution = { timestamp: now.getTime(), modelId: 'model', providerId: 'provider', cost: 1, messages: 1,
    tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } };
  return { contributions: [{ date: day, clients: [{ ...contribution, client: 'codex' }] }],
    sourceUsage: { version: 2, eventIdentityVersion: 2, fullHistory: true, capturedAt: at.toISOString(), bucketTimezone: zone,
      replacementClients: ['codex'], partialClients: [], rowsWithoutIdentity: {},
      scopes: [{ id: 'codex', clients: ['codex'], readStatus: 'complete', identityStatus: 'exact' }],
      sessions: [{ client: 'codex', sessionId: 'one', scopeId: 'codex',
        events: [{ id: 'stable-event', contributions: [contribution] }] }] } };
}
function mimoGraph(tokens = 5) {
  const observation = graph(tokens, now);
  for (const bucket of observation.contributions) for (const row of bucket.clients) row.client = 'micode';
  Object.assign(observation.sourceUsage, { replacementClients: ['micode', 'micode-desktop'],
    scopes: [{ id: 'micode', clients: ['micode', 'micode-desktop'], readStatus: 'complete', identityStatus: 'exact' }] });
  Object.assign(observation.sourceUsage.sessions[0], { client: 'micode', scopeId: 'micode' });
  return observation;
}
function collector(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'source-commit-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'daily.json');
  let snapshot;
  return { home, file, collect: (tokens, tick, writeEnabled, evidence = { version: 1, sessions: {} }, amendGraph = value => value) => {
    const at = new Date(now.getTime() + tick * 1000);
    return collectUsageOnce({ clients: 'codex', deviceId: 'fixture', allTimeSince: '2024-01-01', now: at,
      homeDir: home, env: {}, osInfo: {}, projectsEnabled: false, wslScanEnabled: false, codexLocalUsageEnabled: false,
      includeHistory: true, dailyHistoryArchiveEnabled: true, sourceArchiveSnapshot: snapshot,
      dailyHistoryArchiveOptions: { path: file }, dailyHistoryArchiveWriteEnabled: writeEnabled,
      getSessionUsageArchive: () => evidence,
      sessionMetadataDeps: { resolveSessionMetadata: () => null },
      runTokscale: async () => native(tokens), runGraph: async () => amendGraph(graph(tokens, at)),
      onSourceArchiveComputed: value => { snapshot = value; } });
  } };
}

for (const mode of ['disabled', 'guard changes']) test(`an unlocked correction requires a commit (${mode})`, async t => {
  const f = collector(t);
  await f.collect(45, 0, true);
  const before = fs.readFileSync(f.file, 'utf8');
  let calls = 0;
  const corrected = await f.collect(20, 1, mode === 'disabled' ? false : () => ++calls === 1);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.equal(corrected.allTime.totalTokens, 45);
  assert.equal(corrected.history.summary.totalTokens, 45);
  const recovered = await f.collect(20, 2, true);
  assert.equal(recovered.allTime.totalTokens, 20);
  assert.equal(recovered.history.summary.totalTokens, 20);
  assert.notEqual(fs.readFileSync(f.file, 'utf8'), before);
});

function legacyEntry(client = 'micode', tokens = 100, sessionId = 'released') {
  return { client, sessionId, capturedAt: now.toISOString(), day, month: day.slice(0, 7),
    periodWindows: { allTime: { capturedAt: now.toISOString() } }, sourceState: 'unknown',
    periods: { allTime: { client, sessionId, totalTokens: tokens, inputTokens: tokens,
      costUsd: tokens / 100, models: { model: tokens }, modelCosts: { model: tokens / 100 } } } };
}
function archive(...entries) {
  return { version: 1, sessions: Object.fromEntries(entries.map(entry => [`${entry.client}:${entry.sessionId}`, entry])) };
}

test('released micode evidence survives JSON-to-SQLite and reopen without changing raw identities', t => {
  const f = collector(t);
  const entry = legacyEntry();
  const options = { path: path.join(f.home, 'sessions.json'), databasePath: path.join(f.home, 'sessions.sqlite') };
  fs.writeFileSync(options.path, JSON.stringify(archive(entry)));
  assert.equal(isSessionUsageArchiveEvidence(archive(entry)), true);
  assert.deepEqual(readSessionUsageArchiveEvidence(options).sessions['micode:released'], entry);
  let store = createSessionUsageArchiveStore(options);
  try {
    store.read(now);
    assert.equal(fs.existsSync(options.path), false);
    store.close(); store = createSessionUsageArchiveStore(options);
    const retained = store.readMigrationEvidence();
    assert.deepEqual(retained.sessions['micode:released'], entry);
    const displayed = applySessionUsageArchive({ ...periods(0) }, store.read(now), { now });
    assert.equal(displayed.allTime.clients.mimo, 100);
    assert.equal(displayed.allTime.sessions['mimo:released'].totalTokens, 100);
  } finally { store.close(); }
});

for (const order of ['alias first', 'canonical first']) test(`alias collisions are lossless and order independent (${order})`, async t => {
  const f = collector(t);
  const aliases = Array.from({ length: 100 }, (_, i) => legacyEntry('micode', 100, `old-${i}`));
  const peers = aliases.map(entry => legacyEntry('mimo', 100, entry.sessionId));
  const original = archive(...(order === 'alias first' ? [...aliases, ...peers] : [...peers, ...aliases]));
  assert.equal(isSessionUsageArchiveEvidence(original), true);
  const normalized = normalizeSessionUsageArchive(original);
  assert.equal(Object.keys(normalized.sessions).length, 200);
  const f45 = await f.collect(45, 0, true, original);
  const f15 = await f.collect(15, 1, true, original);
  assert.deepEqual(f45.sessionArchiveSource.ownedClients, ['codex']);
  assert.equal(f15.history.summary.totalTokens, 15);
  assert.equal(f15.allTime.totalTokens, 15);
  const visible = applySessionUsageArchive(f15, normalized, { now });
  assert.equal(visible.allTime.clients.mimo, 10000);
  assert.equal(visible.allTime.totalTokens, 10015);
});

for (const variant of ['total', 'components', 'models', 'cost', 'window', 'frontier', 'wsl']) {
  test(`conflicting alias ${variant} observations remain stored without additive replay`, t => {
    const f = collector(t), alias = legacyEntry(), canonical = legacyEntry('mimo');
    if (variant === 'total') canonical.periods.allTime.totalTokens = 120;
    if (variant === 'components') canonical.periods.allTime.outputTokens = 20;
    if (variant === 'models') canonical.periods.allTime.models = { other: 100 };
    if (variant === 'cost') canonical.periods.allTime.costUsd = 2;
    if (variant === 'window') canonical.periodWindows.allTime.day = '2026-10-01';
    if (variant === 'frontier') canonical.capturedAt = '2026-10-14T00:00:00.000Z';
    if (variant === 'wsl') canonical.accountingSource = 'wsl';
    const first = archive(alias, canonical), reversed = archive(canonical, alias);
    const options = { path: path.join(f.home, 'alias.json'), databasePath: path.join(f.home, 'alias.sqlite') };
    fs.writeFileSync(options.path, JSON.stringify(first));
    const store = createSessionUsageArchiveStore(options);
    try {
      store.read(now);
      const evidence = store.readMigrationEvidence();
      assert.deepEqual(evidence.sessions['micode:released'], alias);
      assert.deepEqual(evidence.sessions['mimo:released'], canonical);
      assert.equal(Object.keys(evidence.sessions).length, 2);
      assert.deepEqual(normalizeSessionUsageArchive(first), normalizeSessionUsageArchive(reversed));
      const left = applySessionUsageArchive({ ...periods(0) }, first, { now });
      const right = applySessionUsageArchive({ ...periods(0) }, reversed, { now });
      assert.deepEqual(left.allTime, right.allTime);
      assert.equal(left.allTime.totalTokens, variant === 'total' ? 120 : 100);
      assert.equal(Object.keys(left.allTime.sessions).filter(key => key.endsWith(':released')).length, 1);
    } finally { store.close(); }
  });
}

test('alias decoding does not sanitize malformed or undocumented identities into evidence', () => {
  for (const mutate of [entry => { entry.client = 'MICODE'; }, entry => { entry.periods.allTime.client = 'mimo'; },
    entry => { entry.periods.allTime.inputTokens = '100'; }, entry => { entry.periods.allTime.costUsd = -1; }]) {
    const entry = legacyEntry(); mutate(entry);
    assert.equal(isSessionUsageArchiveEvidence({ version: 1, sessions: { 'micode:released': entry } }), false);
  }
});

test('an unpriced partial export retains accepted tokens/cost, then a proven free correction commits', async t => {
  const f = collector(t);
  await f.collect(45, 0, true);
  const setCost = (value, status) => {
    value.sourceUsage.scopes[0].readStatus = status;
    value.sourceUsage.scopes[0].reason = status === 'partial' ? 'source cost evidence is unavailable' : undefined;
    for (const day of value.contributions) for (const row of day.clients) row.cost = 0;
    for (const row of value.sourceUsage.sessions) for (const event of row.events) for (const part of event.contributions) part.cost = 0;
    return value;
  };
  const unknown = await f.collect(15, 1, true, undefined, value => setCost(value, 'partial'));
  assert.equal(unknown.allTime.totalTokens, 45);
  assert.equal(unknown.allTime.costUsd, 1);
  assert.equal(unknown.history.summary.totalTokens, 45);
  const free = await f.collect(15, 2, true, undefined, value => setCost(value, 'complete'));
  assert.equal(free.allTime.totalTokens, 15);
  assert.equal(free.allTime.costUsd, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).sourceLedger.scopes.codex.blockNativeWatch, undefined);
});

test('malformed alias handoff keeps its JSON and does not certify an empty database', t => {
  const f = collector(t), invalid = legacyEntry();
  invalid.periods.allTime.inputTokens = '100';
  const options = { path: path.join(f.home, 'invalid.json'), databasePath: path.join(f.home, 'invalid.sqlite') };
  const original = JSON.stringify(archive(invalid));
  fs.writeFileSync(options.path, original);
  const store = createSessionUsageArchiveStore(options);
  try { assert.throws(() => store.read(now), /invalid session archive migration evidence/); }
  finally { store.close(); }
  assert.equal(fs.readFileSync(options.path, 'utf8'), original);
  assert.throws(() => readSessionUsageArchiveEvidence(options), /invalid session archive migration evidence/);
});

test('released alias writer transform and preview reader keep one canonical display without preview writes', t => {
  const f = collector(t), original = archive(legacyEntry(), legacyEntry('mimo'));
  const options = { path: path.join(f.home, 'transform.json'), databasePath: path.join(f.home, 'transform.sqlite') };
  fs.writeFileSync(options.path, JSON.stringify(original));
  const store = createSessionUsageArchiveStore(options);
  try {
    const transform = createUsageTransform({ store, readSnapshot: () => normalizeSessionUsageArchive(original),
      getSettings: () => ({ clients: 'codex,mimo', projectsEnabled: false }) });
    const summary = () => ({ updatedAt: now.toISOString(), ...periods(20) });
    assert.equal(transform.transform(summary(), 'preview', { preview: true }).allTime.totalTokens, 120);
    assert.equal(fs.existsSync(options.databasePath), false);
    assert.equal(fs.readFileSync(options.path, 'utf8'), JSON.stringify(original));
    assert.equal(transform.transform(summary()).allTime.totalTokens, 120);
    assert.deepEqual(store.readMigrationEvidence().sessions['micode:released'], original.sessions['micode:released']);
    assert.deepEqual(store.readMigrationEvidence().sessions['mimo:released'], original.sessions['mimo:released']);
  } finally { store.close(); }
});

for (const reversed of [false, true]) for (const sparse of ['missing', 'frontier only']) {
  test(`each alias period keeps its own fallback window (${sparse}, reversed=${reversed})`, t => {
    const f = collector(t), alias = legacyEntry('micode', 200), peer = legacyEntry('mimo', 100);
    alias.day = '2026-09-30'; alias.month = '2026-09'; alias.capturedAt = '2026-09-30T12:00:00.000Z';
    for (const [name, tokens] of [['today', 20], ['month', 30]]) {
      peer.periods[name] = { ...peer.periods.allTime, totalTokens: tokens, inputTokens: tokens,
        costUsd: tokens / 100, models: { model: tokens }, modelCosts: { model: tokens / 100 } };
      if (sparse === 'frontier only') peer.periodWindows[name] = { capturedAt: peer.capturedAt };
    }
    const original = archive(...(reversed ? [peer, alias] : [alias, peer]));
    const options = { path: path.join(f.home, 'windows.json'), databasePath: path.join(f.home, 'windows.sqlite') };
    fs.writeFileSync(options.path, JSON.stringify(original));
    let store = createSessionUsageArchiveStore(options);
    try {
      const check = retained => {
        const visible = applySessionUsageArchive({ ...periods(0) }, retained, { now });
        assert.equal(visible.today.totalTokens, 20);
        assert.equal(visible.month.totalTokens, 30);
        assert.equal(visible.allTime.totalTokens, 200);
      };
      check(normalizeSessionUsageArchive(original));
      check(store.read(now));
      store.close(); store = createSessionUsageArchiveStore(options);
      check(store.refresh(now, { strict: true }));
      assert.deepEqual(store.readMigrationEvidence().sessions, original.sessions);
      const transform = createUsageTransform({ store, readSnapshot: () => normalizeSessionUsageArchive(original),
        getSettings: () => ({ clients: 'mimo', projectsEnabled: false }) });
      const preview = transform.transform({ updatedAt: now.toISOString(), ...periods(0) }, 'preview', { preview: true });
      assert.equal(preview.today.totalTokens, 20);
      assert.equal(preview.month.totalTokens, 30);
      retainDailyHistory(mimoGraph(), { path: f.file, todayKey: day, timeZone: zone, sessionUsageArchive: original });
      const scope = readDailyHistoryArchive({ path: f.file, fresh: true }).sourceLedger.scopes.micode;
      assert.equal(scope.legacyPeriods.today.day, day);
      assert.equal(scope.legacyPeriods.month.month, day.slice(0, 7));
      assert.equal(scope.legacyPeriods.today.period.totalTokens, 20);
      assert.equal(scope.legacyDays['2026-09-30'], undefined);
      assert.ok(scope.legacyDays[day]);
    } finally { store.close(); }
  });
}

for (const conflict of ['model', 'components', null]) test(`dated alias allocation survives recovery only with consistent observations (conflict=${conflict})`, t => {
  const f = collector(t), alias = legacyEntry(), peer = legacyEntry('mimo');
  for (const entry of [alias, peer]) {
    entry.periods.today = { ...entry.periods.allTime };
    entry.periodWindows.today = { day, capturedAt: now.toISOString() };
  }
  if (conflict === 'model') peer.periods.today.models = { other: 100 };
  if (conflict === 'components') Object.assign(peer.periods.today, { inputTokens: 80, outputTokens: 20 });
  const observation = mimoGraph();
  const options = { path: f.file, todayKey: day, timeZone: zone, sessionUsageArchive: archive(alias, peer) };
  retainDailyHistory(observation, options);
  const assertAllocation = retained => {
    const scope = retained.sourceLedger.scopes.micode;
    assert.equal(scope.mode, 'legacy');
    assert.equal(Boolean(scope.legacyDays[day].sessionAllocation?.['mimo:released']), !conflict);
    assert.equal(Boolean(scope.legacyPeriods.today.period.sessions['mimo:released']), !conflict);
    assert.equal(scope.unresolvedBoundary, true);
    const projection = graphFromDailyHistoryArchive([], retained, options).sourceUsage;
    const wsl = Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, extractUsageFromTokscale({ entries: [
      { client: 'mimo', sessionId: 'released', model: 'model', input: 12, cost: 0.12 }
    ] })]));
    const summary = periods(0);
    applySourceDailyUsage(summary, projection, { ...options, clients: 'mimo', nativePeriods: periods(0),
      supplementalPeriods: wsl, wslPeriods: wsl, wslSessionKeys: ['mimo:released'] });
    assert.equal(summary.today.totalTokens, 100);
    assert.equal(summary.allTime.totalTokens, 100);
  };
  assertAllocation(readDailyHistoryArchive({ ...options, fresh: true }));
  const serialized = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assertAllocation(serialized);
});

test('a disabled writer cannot acquire first source ownership', async t => {
  const f = collector(t);
  const result = await f.collect(20, 0, false);
  assert.equal(fs.existsSync(f.file), false);
  assert.deepEqual(result.sessionArchiveSource?.ownedClients || [], []);
  assert.equal(result.allTime.totalTokens, 20);
  const committed = await f.collect(20, 1, true);
  assert.deepEqual(committed.sessionArchiveSource.ownedClients, ['codex']);
});

for (const revoked of [true, false]) test(`mutating and read-only projection respect title evidence (revoked=${revoked})`, () => {
  const old = { updatedAt: now.toISOString(), ...periods(100) };
  for (const name of ['today', 'month', 'allTime']) old[name].sessions['codex:one'].title = 'Old catalog title';
  const archive = captureSessionUsageArchive({}, old, now);
  const fresh = () => ({ updatedAt: now.toISOString(), ...periods(100),
    sessionArchiveSource: { managedKeys: ['codex:one'], ownedClients: ['codex'], boundaryCheckedClients: ['codex'],
      ...(revoked ? { revokedTitles: { 'codex:one': 'Old catalog title' } } : {}) } });
  const transform = createUsageTransform({ getSettings: () => ({ clients: 'codex', projectsEnabled: false }),
    isExternalAgentActive: () => true, store: { refresh: () => structuredClone(archive),
      capture: () => { throw new Error('read-only fixture must not capture'); } } });
  for (const result of [applySessionUsageArchive(fresh(), archive, { now, mutate: false }),
    applySessionUsageArchive(fresh(), archive, { now, mutate: true }), transform.transform(fresh())]) {
    assert.equal(result.allTime.sessions['codex:one'].title || '', revoked ? '' : 'Old catalog title');
    assert.equal(result.allTime.totalTokens, 100);
    assert.equal(result.sessionArchiveSource, undefined);
  }
});
