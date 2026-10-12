'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { collectUsageOnce, localTodayKey } = require('../../src/shared/collector');
const { captureDailyHistoryArchive, captureLiveDailyHistory, graphFromDailyHistoryArchive, normalizeDailyHistoryArchive } = require('../../src/shared/dailyHistoryArchive');
const { applySourceDailyUsage } = require('../../src/shared/usage/sourceDailyUsage');
const { legacyAllocationMatches, legacyDaysMatch, selectLegacyDay } = require('../../src/shared/usage/sourceLedger');
const { captureSessionUsageArchive, applySessionUsageArchive, updateSessionUsageArchive, isSessionUsageArchiveEvidence } = require('../../src/shared/usage/sessionUsageArchive');
const { createSessionUsageArchiveStore, readSessionUsageArchiveEvidence } = require('../../src/shared/usage/sessionUsageArchiveStore');
const { extractUsageFromTokscale } = require('../../src/shared/usage');
const { normalizeHistory, parseGraphResult } = require('../../src/shared/history');
const { serializeSyncPayload } = require('../../src/shared/syncPayload');

const now = new Date(2026, 9, 11, 12);
const todayKey = localTodayKey(now);
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const calendar = { todayKey, timeZone, sessionUsageArchive: { version: 1, sessions: {} } };
const emptyArchive = () => ({ version: 1, sessions: {} });
const later = seconds => new Date(now.getTime() + seconds * 1000);
const row = (client, sessionId, tokens, scopeId = client) => ({ client, sessionId, tokens, scopeId });

function graph(rows, clock = now, statuses = {}) {
  const clients = [...new Set(rows.map(value => value.client))];
  const scopes = [...new Set(rows.map(value => value.scopeId))].map(id => ({ id,
    clients: [...new Set(rows.filter(value => value.scopeId === id).map(value => value.client))],
    readStatus: statuses[id] || 'complete', identityStatus: 'exact' }));
  const contributions = rows.filter(value => value.tokens > 0).map(value => ({ date: todayKey, clients: [{
    client: value.client, modelId: 'model', providerId: 'provider',
    tokens: { input: value.tokens, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: value.tokens / 100, messages: 1
  }] }));
  return { contributions, sourceUsage: { version: 2, eventIdentityVersion: 2,
    capturedAt: clock.toISOString(), fullHistory: true, bucketTimezone: timeZone,
    replacementClients: clients, partialClients: [], rowsWithoutIdentity: {}, scopes,
    sessions: rows.map(value => ({ client: value.client, sessionId: value.sessionId, scopeId: value.scopeId,
      events: value.tokens === 0 ? [] : [{ id: `event:${value.sessionId}`, contributions: [{ timestamp: now.getTime(),
        modelId: 'model', providerId: 'provider', cost: value.tokens / 100, messages: 1,
        tokens: { input: value.tokens, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }] }] })) } };
}

function native(rows) {
  return { entries: rows.filter(value => value.tokens > 0).map(value => ({ client: value.client,
    sessionId: value.sessionId, model: 'model', provider: 'provider', input: value.tokens, cost: value.tokens / 100 })) };
}
function summary(rows) {
  const period = extractUsageFromTokscale(native(rows));
  return { updatedAt: now.toISOString(), periodWindows: { timeZone },
    today: structuredClone(period), month: structuredClone(period), allTime: structuredClone(period),
    sessionArchiveSource: { fullScan: true, presentKeys: Object.keys(period.sessions) } };
}
const generic = rows => captureSessionUsageArchive({}, summary(rows), now);
const roundTrip = archive => normalizeDailyHistoryArchive(JSON.parse(JSON.stringify(archive)));
function project(archive, rows = [], options = {}) {
  const result = summary(rows);
  const retainedGraph = graphFromDailyHistoryArchive([], archive, calendar);
  applySourceDailyUsage(result, retainedGraph.sourceUsage, { ...calendar, ...options });
  result.history = normalizeHistory(parseGraphResult(retainedGraph), calendar);
  return result;
}
function assertCounters(result, expected) {
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(result[name].totalTokens, expected, name);
    assert.equal(Object.values(result[name].sessions).reduce((sum, session) => sum + session.totalTokens, 0), expected, `${name} sessions`);
    assert.ok(Math.abs(result[name].costUsd - expected / 100) < 1e-9, `${name} cost`);
  }
  assert.equal(result.history.summary.totalTokens, expected, 'known allocated History');
}
function runtime(t, clients) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-boundaries-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { clients, allTimeSince: '2026-01-01', deviceId: 'boundary-fixture', homeDir: dir, env: {},
    wslScanEnabled: false, projectsEnabled: false, codexLocalUsageEnabled: false,
    includeHistory: true, dailyHistoryArchiveEnabled: true, getSessionUsageArchive: emptyArchive,
    dailyHistoryArchiveOptions: { path: path.join(dir, 'daily.json') },
    sessionMetadataDeps: { resolveSessionMetadata: () => null } };
}

test('canonical Devin boundary stays legacy across exact CLI, partial desktop, generic capture and absence', async t => {
  const options = runtime(t, 'devin');
  const cli = row('devin-cli', 'A', 30);
  const desktop = row('devin-desktop', 'B', 20);
  let archive = generic([desktop]);
  const scan = graph([cli, desktop], now, { 'devin-desktop': 'partial' });
  let projection;
  const first = await collectUsageOnce({ ...options, now, getSessionUsageArchive: () => archive,
    runTokscale: async () => native([cli, desktop]), runGraph: async () => scan,
    onSourceArchiveComputed: value => { projection = value; } });
  assert.deepEqual(projection.ownedClients, []);
  assertCounters(applySessionUsageArchive(first, archive, { now }), 50);
  archive = updateSessionUsageArchive(archive, first, now).archive;
  assert.equal(archive.sessions['devin:B'].periods.allTime.totalTokens, 20, 'unmigrated evidence survives capture');
  const absent = graph([cli, row('devin-desktop', 'B', 0)], later(1), { 'devin-desktop': 'unknown' });
  absent.sourceUsage.sessions = absent.sourceUsage.sessions.filter(value => value.client !== 'devin-desktop');
  const second = await collectUsageOnce({ ...options, now: later(1), getSessionUsageArchive: () => archive,
    runTokscale: async () => native([cli]), runGraph: async () => absent });
  assertCounters(applySessionUsageArchive(second, archive, { now: later(1) }), 50);
  const disk = JSON.parse(fs.readFileSync(options.dailyHistoryArchiveOptions.path));
  assert.deepEqual(disk.sourceLedger.scopes, {}, 'no fabricated raw B legacy copy of A');
  assert.equal(disk.sourceLedger.observations['devin-cli'].reason, 'canonical-legacy-scope');
});

test('unowned same-canonical partial peer preserves smaller generic desktop evidence on the ordinary legacy path', () => {
  const cli = row('devin-cli', 'A', 30);
  const input = graph([cli, row('devin-desktop', 'B', 0)], now, { 'devin-desktop': 'partial' });
  const prior = generic([row('devin-desktop', 'B', 20)]);
  const archive = captureDailyHistoryArchive({}, input, { ...calendar, sessionUsageArchive: prior });
  const result = project(archive, [cli]);
  assert.deepEqual(result.sessionArchiveSource.ownedClients, []);
  assert.equal(applySessionUsageArchive(result, prior, { now }).allTime.totalTokens, 50);
  assert.equal(updateSessionUsageArchive(prior, result, now).archive.sessions['devin:B'].periods.allTime.totalTokens, 20);
});

test('old direct API calls without retained evidence cannot acquire ownership or retire unmanaged generic rows', () => {
  const cli = row('devin-cli', 'A', 30);
  const prior = generic([row('devin-desktop', 'B', 20)]);
  const archive = captureDailyHistoryArchive({}, graph([cli]), { todayKey, timeZone });
  assert.deepEqual(archive.sourceLedger.scopes, {});
  assert.equal(archive.sourceLedger.observations['devin-cli'].reason, 'retained-evidence-unavailable');
  const result = project(archive, [cli]);
  assert.equal(applySessionUsageArchive(result, prior, { now }).allTime.totalTokens, 50);
  assert.equal(updateSessionUsageArchive(prior, result, now).archive.sessions['devin:B'].periods.allTime.totalTokens, 20);
  const unchecked = JSON.parse(JSON.stringify(captureDailyHistoryArchive({}, graph([cli]), calendar)));
  delete unchecked.sourceLedger.scopes['devin-cli'].proof.retainedBoundaryChecked;
  const priorResult = project(roundTrip(unchecked), [cli]);
  assert.deepEqual(priorResult.sessionArchiveSource.boundaryCheckedClients, []);
  assert.equal(applySessionUsageArchive(priorResult, prior, { now }).allTime.totalTokens, 50, 'defensive consumer preserves unchecked evidence');
  const attempted = captureDailyHistoryArchive(unchecked, graph([cli], later(1)), { ...calendar, sessionUsageArchive: prior });
  assert.equal(attempted.sourceLedger.scopes['devin-cli'].proof.retainedBoundaryChecked, undefined);
  assert.equal(attempted.sourceLedger.scopes['devin-cli'].blockNativeWatch, true);
});

test('generic-only retained counters participate before direct API acceptance, preserving exclusive100 rather than120', () => {
  const prior = generic([row('codex', 'unknown-old-ID', 100)]);
  const fresh = row('codex', 'new-ID', 20);
  const archive = roundTrip(captureDailyHistoryArchive({}, graph([fresh]), { ...calendar, sessionUsageArchive: prior }));
  assert.equal(archive.sourceLedger.scopes.codex.mode, 'legacy');
  assert.equal(archive.sourceLedger.scopes.codex.unresolvedBoundary, true);
  const result = project(archive, [fresh]);
  assertCounters(applySessionUsageArchive(result, prior, { now }), 100);
  const captured = updateSessionUsageArchive(prior, result, now).archive;
  assert.equal(captured.sessions['codex:unknown-old-ID'].periods.allTime.totalTokens, 100);
  assert.equal(captured.sessions['codex:new-ID'], undefined);
});

test('one exclusive generic boundary advances100 to150 to180, survives reload/fallback, and keeps native watch anchors exact', async t => {
  const options = runtime(t, 'codex');
  const prior = generic([row('codex', 'old', 100)]);
  let anchor;
  let projection;
  const full = (tokens, clock, input = graph([row('codex', 'new', tokens)], clock)) => collectUsageOnce({ ...options,
    now: clock, sessionUsageArchive: prior, runTokscale: async () => native([row('codex', 'new', tokens)]), runGraph: async () => input,
    onAnchorComputed: value => { anchor = value; }, onSourceArchiveComputed: value => { projection = value; } });
  const watch = async (tokens, clock) => {
    let calls = 0;
    const result = await collectUsageOnce({ ...options, now: clock, includeHistory: false, sourceArchiveSnapshot: projection,
      todayOnlyAnchor: { ...anchor.windowsPeriods, dateKey: todayKey, todayPartitions: anchor.todayPartitions, nativeRawPresence: anchor.nativeRawPresence },
      runTokscale: async ({ flags }) => { calls++; assert.deepEqual(flags, ['--today']); return native([row('codex', 'new', tokens)]); },
      getSessionUsageArchive: () => { throw new Error('watch must not read generic evidence'); } });
    assert.equal(calls, 1);
    return result;
  };
  assertCounters(await full(20, now), 100);
  for (const name of ['today', 'month', 'allTime']) assert.equal(anchor.windowsPeriods[name].totalTokens, 20, 'native anchor excludes generic100');
  for (const name of ['today', 'month', 'allTime']) assert.equal((await watch(25, later(1)))[name].totalTokens, 100, 'no invented105 residual');
  assertCounters(await full(150, later(2)), 150);
  const grownWatch = await watch(180, later(3));
  for (const name of ['today', 'month', 'allTime']) assert.equal(grownWatch[name].totalTokens, 180, 'no additive legacy/native duplicate');
  assertCounters(await full(180, later(4)), 180);
  let disk = JSON.parse(fs.readFileSync(options.dailyHistoryArchiveOptions.path));
  assert.equal(disk.sourceLedger.scopes.codex.mode, 'legacy');
  assert.equal(disk.sourceLedger.scopes.codex.events && Object.keys(disk.sourceLedger.scopes.codex.events).length, 0);
  assertCounters(project(roundTrip(disk), [row('codex', 'new', 20)]), 180);
  assert.equal(updateSessionUsageArchive(prior, grownWatch, later(4)).archive.sessions['codex:old'].periods.allTime.totalTokens, 100);
  assert.equal(prior.sessions['codex:new'], undefined);
  const stale = graph([row('codex', 'new', 250)], now);
  assertCounters(await full(250, later(5), stale), 180);
  const partial = graph([row('codex', 'new', 250)], later(6), { codex: 'partial' });
  assertCounters(await full(250, later(6), partial), 180);
  for (const name of ['today', 'month', 'allTime']) assert.equal((await watch(260, later(7)))[name].totalTokens, 180);
  assertCounters(await full(180, later(8)), 180);
  const fallback = { contributions: [], meta: { generatedAt: later(9).toISOString() } };
  assertCounters(await full(300, later(9), fallback), 180);
  disk = JSON.parse(fs.readFileSync(options.dailyHistoryArchiveOptions.path));
  assertCounters(project(roundTrip(disk)), 180);
  assert.equal(disk.sourceLedger.scopes.codex.mode, 'legacy');
});

test('legacy progression keeps real period windows and never allocates the unknown allTime residual to a day', () => {
  const prior = generic([row('codex', 'old', 100)]);
  let archive = captureDailyHistoryArchive({}, graph([row('codex', 'new', 20)]), { ...calendar, sessionUsageArchive: prior,
    nativePeriods: summary([row('codex', 'new', 20)]) });
  const tomorrow = new Date(now.getTime() + 86400000);
  const day = localTodayKey(tomorrow);
  const period = tokens => extractUsageFromTokscale(native([row('codex', 'new', tokens)]));
  archive = roundTrip(captureDailyHistoryArchive(archive, graph([row('codex', 'new', 160)], tomorrow), {
    ...calendar, todayKey: day, sessionUsageArchive: prior, nativePeriods: { today: period(5), month: period(160), allTime: period(160) } }));
  const projected = summary([]);
  const retained = graphFromDailyHistoryArchive([], archive, { ...calendar, todayKey: day });
  applySourceDailyUsage(projected, retained.sourceUsage, { ...calendar, todayKey: day });
  assert.equal(projected.today.totalTokens, 5);
  assert.equal(projected.month.totalTokens, 160);
  assert.equal(projected.allTime.totalTokens, 160);
  assert.equal(normalizeHistory(parseGraphResult(retained), { todayKey: day }).summary.totalTokens, 105, 'only actual100 old day plus5 new day allocated');
  assert.equal(archive.sourceLedger.scopes.codex.mode, 'legacy');
});

function datedLegacyFixture(clock = now, sessionId = 'new') {
  const today = localTodayKey(clock);
  const oldDay = new Date(clock.getTime() - 86400000);
  const priorPeriod = extractUsageFromTokscale({ entries: [{ client: 'codex', sessionId: 'old', model: 'old-model',
    input: 70, output: 20, cacheRead: 10, cost: 4 }] });
  const prior = captureSessionUsageArchive({}, { today: priorPeriod, month: priorPeriod, allTime: priorPeriod }, oldDay);
  const period = (tokens, id = sessionId, model = 'new-model', cost = tokens / 10) => extractUsageFromTokscale({ entries: [
    { client: 'codex', sessionId: id, model, input: tokens, cost }] });
  const nativePeriods = { today: period(5), month: period(localTodayKey(oldDay).slice(0, 7) === today.slice(0, 7) ? 25 : 5), allTime: period(25) };
  const input = graph([row('codex', sessionId, 25)], clock);
  input.contributions = [];
  input.sourceUsage.sessions[0].events = [
    { id: 'yesterday-turn', contributions: [{ timestamp: oldDay.getTime(), modelId: 'new-model', providerId: '',
      tokens: { input: 20, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: 2, messages: 1 }] },
    { id: 'today-turn', contributions: [{ timestamp: clock.getTime(), modelId: 'new-model', providerId: '',
      tokens: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: 0.5, messages: 1 }] }
  ];
  const options = { ...calendar, todayKey: today, sessionUsageArchive: prior, nativePeriods };
  const display = (archive, overrides = {}) => {
    const result = { updatedAt: clock.toISOString(), periodWindows: { timeZone },
      today: extractUsageFromTokscale({ entries: [] }), month: extractUsageFromTokscale({ entries: [] }),
      allTime: extractUsageFromTokscale({ entries: [] }), ...overrides };
    const retained = graphFromDailyHistoryArchive([], archive, { ...options, ...overrides.calendar });
    applySourceDailyUsage(result, retained.sourceUsage, { ...options, ...overrides.calendar });
    result.history = normalizeHistory(parseGraphResult(retained), { ...options, ...overrides.calendar });
    return result;
  };
  return { input, prior, period, nativePeriods, options, display, clock, oldDay };
}

function pricedLegacyFixture(entries) {
  const fixture = datedLegacyFixture();
  const priorPeriod = extractUsageFromTokscale({ entries });
  fixture.prior = captureSessionUsageArchive({}, { today: priorPeriod, month: priorPeriod, allTime: priorPeriod }, fixture.oldDay);
  fixture.options.sessionUsageArchive = fixture.prior;
  const clients = [...new Set(entries.map(entry => entry.client))];
  const sampleEvents = fixture.input.sourceUsage.sessions[0].events;
  fixture.input = graph(clients.map(client => row(client, 'new', 25, 'priced-domain')));
  fixture.input.contributions = [];
  for (const session of fixture.input.sourceUsage.sessions) session.events = structuredClone(sampleEvents);
  const period = tokens => extractUsageFromTokscale({ entries: clients.map(client => ({
    client, sessionId: 'new', model: 'new-model', input: tokens, cost: tokens / 10 })) });
  fixture.options.nativePeriods = { today: period(5), month: period(25), allTime: period(25) };
  return { ...fixture, priorPeriod };
}

for (const costs of [[0.1, 0.2, 0.4], [0.00252, 0.00088, 0.00577, 0.00223, 0.00376, 0.00026, 0.00447, 0.00118]]) {
  test(`${costs.length} priced dated sessions survive regrouping, permutations, recovery and fallback without rounding stored costs`, () => {
    const entries = costs.map((cost, index) => ({ client: 'codex', sessionId: `priced${index}`,
      model: `model${index % (costs.length === 3 ? 2 : 3)}`, input: 10, cost }));
    for (const permutation of [entries, [...entries].reverse(), [...entries.slice(1), entries[0]]]) {
      const fixture = pricedLegacyFixture(permutation);
      let archive = captureDailyHistoryArchive({}, fixture.input, fixture.options);
      const oldDay = localTodayKey(fixture.oldDay);
      const selected = structuredClone(archive.sourceLedger.scopes['priced-domain'].legacyDays[oldDay].observations);
      const assertAllocated = result => {
        assert.equal(result.today.totalTokens, 5);
        for (const name of ['month', 'allTime']) {
          assert.equal(result[name].totalTokens, entries.length * 10 + 5);
          assert.equal(Object.values(result[name].sessions).reduce((sum, session) => sum + session.totalTokens, 0), entries.length * 10 + 5);
          assert.ok(Math.abs(result[name].costUsd - (fixture.priorPeriod.costUsd + 0.5)) < 1e-15);
          for (const entry of entries) assert.equal(result[name].sessions[`codex:${entry.sessionId}`].costUsd, entry.cost);
          assert.equal(result[name].modelCosts.unknown, undefined, 'roundoff does not create hidden monetary attribution');
        }
        assert.equal(result.history.summary.totalTokens, entries.length * 10 + 5);
      };
      assertAllocated(fixture.display(archive));
      archive = roundTrip(archive);
      assertAllocated(fixture.display(archive));
      delete archive.sourceLedger.scopes['priced-domain'].legacyDays[oldDay].sessionAllocation;
      fixture.input.sourceUsage.capturedAt = later(1).toISOString();
      archive = captureDailyHistoryArchive(archive, fixture.input, fixture.options);
      assertAllocated(fixture.display(archive));
      archive = roundTrip(captureDailyHistoryArchive(archive, { contributions: [] }, fixture.options));
      assertAllocated(fixture.display(archive));
      assert.deepEqual(archive.sourceLedger.scopes['priced-domain'].legacyDays[oldDay].observations, selected,
        'the selected observation is retained, including its original cost values');
    }
  });
}

test('dated fractional allocations retain multiple clients/models and zero-token priced rows together', () => {
  const entries = [
    { client: 'codex', sessionId: 'c0', model: 'shared-model', input: 30, cost: 0.1 },
    { client: 'codex', sessionId: 'c1', model: 'fee-model', input: 0, cost: 0.2 },
    { client: 'claude', sessionId: 'a0', model: 'shared-model', input: 30, cost: 0.4 },
    { client: 'claude', sessionId: 'a1', model: 'fee-model', input: 0, cost: 0.05 }
  ];
  const fixture = pricedLegacyFixture(entries);
  const archive = roundTrip(captureDailyHistoryArchive({}, fixture.input, fixture.options));
  const result = fixture.display(archive);
  assert.equal(result.allTime.totalTokens, 70);
  assert.equal(Object.values(result.allTime.sessions).reduce((sum, session) => sum + session.totalTokens, 0), 70);
  for (const entry of entries) {
    assert.equal(result.allTime.sessions[`${entry.client}:${entry.sessionId}`].costUsd, entry.cost);
    assert.equal(result.allTime.sessions[`${entry.client}:${entry.sessionId}`].totalTokens, entry.input);
  }
  assert.deepEqual(result.allTime.clientModels, { codex: { 'shared-model': 30, 'new-model': 5 }, claude: { 'shared-model': 30, 'new-model': 5 } });
  assert.equal(result.allTime.modelCosts['fee-model'], 0.25);
  assert.equal(result.history.summary.totalTokens, 70);
});

test('monetary attribution permits only finite regrouping error while token/model/client accounting remains exact', () => {
  const period = extractUsageFromTokscale({ entries: [
    { client: 'codex', sessionId: 'a', model: 'm0', input: 10, cost: 0.1 },
    { client: 'codex', sessionId: 'b', model: 'm1', input: 10, cost: 0.2 },
    { client: 'codex', sessionId: 'c', model: 'm0', input: 10, cost: 0.4 }
  ] });
  const regrouped = structuredClone(period);
  regrouped.costUsd = 0.7;
  regrouped.clientCosts.codex = 0.7;
  regrouped.modelCosts.m0 = 0.1 + 0.4;
  assert.equal(legacyAllocationMatches(regrouped, period, 3), true);
  const residue = structuredClone(regrouped);
  residue.modelCosts.unknown = 1.1102230246251565e-16;
  residue.clientModelCosts.codex.unknown = 1.1102230246251565e-16;
  assert.equal(legacyAllocationMatches(residue, period, 3), true);
  for (const change of [
    value => { value.costUsd += 0.000001; },
    value => { value.clientCosts.codex += 0.000001; },
    value => { value.modelCosts.m0 -= 0.01; value.modelCosts.m1 += 0.01; },
    value => { value.clientModelCosts.codex.m0 -= 0.01; value.clientModelCosts.codex.m1 += 0.01; },
    value => { value.modelCosts.unknown = 0.000001; },
    value => { value.models.unknown = 1; },
    value => { value.models.m0--; value.models.m1++; },
    value => { value.clientModels.codex.m0--; value.clientModels.codex.m1++; },
    value => { value.clients.codex--; value.clients.claude = 1; },
    value => { value.outputTokens++; },
    value => { value.unclassifiedTokens = 1; },
    value => { value.modelOutputs.m0 = 1; },
    value => { value.modelCacheReads.m0 = 1; },
    value => { value.modelCacheWrites.m0 = 1; },
    value => { value.modelUnclassifiedTokens.m0 = 1; }
  ]) {
    const mismatch = structuredClone(residue);
    change(mismatch);
    assert.equal(legacyAllocationMatches(mismatch, period, 3), false);
  }
  for (const invalid of [NaN, Infinity, -Infinity, -0.1, '0.7']) {
    for (const field of ['costUsd', 'clientCosts', 'modelCosts', 'clientModelCosts']) {
      const mismatch = structuredClone(regrouped);
      if (field === 'costUsd') mismatch.costUsd = invalid;
      else if (field === 'clientCosts') mismatch.clientCosts.codex = invalid;
      else if (field === 'modelCosts') mismatch.modelCosts.m0 = invalid;
      else mismatch.clientModelCosts.codex.m0 = invalid;
      assert.equal(legacyAllocationMatches(mismatch, period, 3), false, `${field}: ${invalid}`);
    }
  }
});

test('complete day matching rejects material unknown residual, tokens, identity and component changes', () => {
  const date = localTodayKey(new Date(now.getTime() - 86400000));
  const base = { date, observations: { m0: { client: 'codex', modelId: 'm0', tokens: 30, cost: 0.7, messages: 0 } } };
  const rounded = structuredClone(base);
  rounded.observations.m0.cost = 0.1 + 0.2 + 0.4;
  rounded.observations.residue = { client: 'codex', modelId: 'unknown', tokens: 0, cost: 1.1102230246251565e-16, messages: 0 };
  assert.equal(legacyDaysMatch(base, rounded, 3), true);
  for (const change of [
    day => { day.observations.residue.cost = 0.001; },
    day => { day.observations.residue.tokens = 1; },
    day => { day.observations.residue.messages = 1; },
    day => { day.observations.residue.providerId = 'other'; },
    day => { day.observations.m0.modelId = 'm1'; },
    day => { day.observations.m0.client = 'claude'; },
    day => { day.observations.m0.tokens = 31; },
    day => { day.componentSummary = { tokenComponentsAvailable: true }; }
  ]) {
    const mismatch = structuredClone(rounded);
    change(mismatch);
    assert.equal(legacyDaysMatch(base, mismatch, 3), false);
  }
  const repriced = structuredClone(base);
  repriced.observations.m0.cost = 0.8;
  repriced.sessionAllocation = { 'codex:winning': { costUsd: 0.8 } };
  assert.equal(selectLegacyDay(base, repriced), repriced, 'equal-token material repricing still selects the whole greater-cost observation');
});

test('legitimate unknown monetary residual stays explicit and cannot attach unrelated session allocation', () => {
  const fixture = pricedLegacyFixture([{ client: 'codex', sessionId: 'priced', model: 'm0', input: 30, cost: 0.7 }]);
  const archive = captureDailyHistoryArchive({}, fixture.input, fixture.options);
  const oldDay = localTodayKey(fixture.oldDay);
  const day = archive.sourceLedger.scopes['priced-domain'].legacyDays[oldDay];
  day.observations[JSON.stringify(['codex', 'unknown'])] = { client: 'codex', modelId: 'unknown', tokens: 0, cost: 0.01, messages: 0 };
  const result = fixture.display(roundTrip(archive));
  assert.equal(result.allTime.totalTokens, 35);
  assert.equal(result.allTime.modelCosts.unknown, 0.01);
  assert.ok(Math.abs(result.allTime.costUsd - 1.21) < 1e-15);
  assert.equal(result.allTime.sessions['codex:priced'], undefined, 'material unattributed cost cannot be silently assigned to known sessions');
  assert.equal(result.allTime.sessions['codex:new'].totalTokens, 5);
});

test('R4 stored rounding-only unknown observations retain valid attribution without erasing their selected monetary evidence', () => {
  const fixture = pricedLegacyFixture([
    { client: 'codex', sessionId: 'a', model: 'm0', input: 10, cost: 0.1 },
    { client: 'codex', sessionId: 'b', model: 'm1', input: 10, cost: 0.2 },
    { client: 'codex', sessionId: 'c', model: 'm0', input: 10, cost: 0.4 }
  ]);
  const archive = captureDailyHistoryArchive({}, fixture.input, fixture.options);
  const oldDay = localTodayKey(fixture.oldDay);
  const day = archive.sourceLedger.scopes['priced-domain'].legacyDays[oldDay];
  day.observations[JSON.stringify(['codex', 'unknown'])] = { client: 'codex', modelId: 'unknown', tokens: 0,
    cost: 1.1102230246251565e-16, messages: 0, tokenComponentsAvailable: true };
  day.observations[JSON.stringify(['unknown', 'unknown'])] = { client: 'unknown', modelId: 'unknown', tokens: 0,
    cost: 1.1102230246251565e-16, messages: 0, tokenComponentsAvailable: true };
  const reloaded = roundTrip(archive);
  const result = fixture.display(reloaded);
  assert.equal(result.allTime.totalTokens, 35);
  assert.equal(Object.values(result.allTime.sessions).reduce((sum, session) => sum + session.totalTokens, 0), 35);
  assert.equal(result.allTime.sessions['codex:a'].costUsd, 0.1);
  assert.equal(result.allTime.sessions['codex:b'].costUsd, 0.2);
  assert.equal(result.allTime.sessions['codex:c'].costUsd, 0.4);
  assert.deepEqual(reloaded.sourceLedger.scopes['priced-domain'].legacyDays[oldDay].observations, day.observations);
});

test('unknown legacy components remain unknown in no-summary days, sessions and all projections through fallback', () => {
  const fixture = pricedLegacyFixture([{ client: 'codex', sessionId: 'unknown-old', model: 'old-model', totalTokens: 100, cost: 1 }]);
  let archive = captureDailyHistoryArchive({}, fixture.input, fixture.options);
  const oldDay = localTodayKey(fixture.oldDay);
  assert.equal(archive.sourceLedger.scopes['priced-domain'].legacyDays[oldDay].componentSummary, undefined);
  const check = result => {
    for (const name of ['month', 'allTime']) {
      assert.equal(result[name].totalTokens, 105);
      assert.equal(Object.values(result[name].sessions).reduce((sum, session) => sum + session.totalTokens, 0), 105);
      assert.equal(result[name].capabilities.tokenComponents, false);
      assert.ok(result[name].unclassifiedTokens >= 100);
      assert.ok(result[name].clientUnclassifiedTokens.codex >= 100);
      assert.equal(result[name].modelUnclassifiedTokens['old-model'], 100);
      assert.equal(result[name].sessions['codex:unknown-old'].inputTokens, 0);
      assert.equal(result[name].sessions['codex:unknown-old'].outputTokens, 0);
    }
    assert.equal(result.history.summary.totalTokens, 105);
  };
  check(fixture.display(archive));
  check(fixture.display(roundTrip(archive)));
  delete archive.sourceLedger.scopes['priced-domain'].legacyDays[oldDay].sessionAllocation;
  fixture.input.sourceUsage.capturedAt = later(1).toISOString();
  archive = captureDailyHistoryArchive(archive, fixture.input, fixture.options);
  check(fixture.display(archive));
  archive = roundTrip(captureDailyHistoryArchive(archive, { contributions: [] }, fixture.options));
  check(fixture.display(archive));
});

test('mixed unknown and partial components retain known output/cache and unknown remainder per client/model/session', () => {
  const fixture = pricedLegacyFixture([
    { client: 'codex', sessionId: 'unknown-old', model: 'unknown-model', totalTokens: 40, cost: 0.1 },
    { client: 'codex', sessionId: 'partial', model: 'partial-model', totalTokens: 30, output: 5, cacheRead: 3, cost: 0.2 },
    { client: 'claude', sessionId: 'other', model: 'other-model', totalTokens: 50, cacheWrite: 4, cost: 0.4 }
  ]);
  const archive = roundTrip(captureDailyHistoryArchive({}, fixture.input, fixture.options));
  const result = fixture.display(archive);
  assert.equal(result.allTime.totalTokens, 130);
  assert.equal(Object.values(result.allTime.sessions).reduce((sum, session) => sum + session.totalTokens, 0), 130);
  assert.equal(result.allTime.capabilities.tokenComponents, false);
  assert.equal(result.allTime.outputTokens, 5);
  assert.equal(result.allTime.cacheReadTokens, 3);
  assert.equal(result.allTime.cacheWriteTokens, 4);
  assert.equal(result.allTime.unclassifiedTokens, 118);
  assert.deepEqual(result.allTime.clientUnclassifiedTokens, { codex: 67, claude: 51 });
  assert.deepEqual(result.allTime.modelUnclassifiedTokens, { 'unknown-model': 40, 'partial-model': 22, 'other-model': 46, 'new-model': 10 });
  assert.equal(result.allTime.modelOutputs['partial-model'], 5);
  assert.equal(result.allTime.modelCacheReads['partial-model'], 3);
  assert.equal(result.allTime.modelCacheWrites['other-model'], 4);
  assert.equal(result.allTime.sessions['codex:unknown-old'].inputTokens, 0);
  assert.equal(result.allTime.sessions['codex:partial'].inputTokens, 0);
  assert.equal(result.allTime.sessions['codex:partial'].outputTokens, 5);
  assert.equal(result.allTime.sessions['codex:partial'].cacheReadTokens, 3);
});

test('older no-summary observation-level partial provenance retains known fields without inventing input', () => {
  const fixture = pricedLegacyFixture([{ client: 'codex', sessionId: 'partial', model: 'partial-model',
    totalTokens: 100, output: 20, cacheRead: 10, cost: 1 }]);
  const archive = captureDailyHistoryArchive({}, fixture.input, fixture.options);
  const day = archive.sourceLedger.scopes['priced-domain'].legacyDays[localTodayKey(fixture.oldDay)];
  const observation = Object.values(day.observations)[0];
  Object.assign(observation, { outputTokens: 20, cacheReadTokens: 10, unclassifiedTokens: 70 });
  delete day.componentSummary;
  delete day.sessionAllocation;
  const result = fixture.display(roundTrip(archive));
  assert.equal(result.allTime.totalTokens, 105);
  assert.equal(result.allTime.capabilities.tokenComponents, false);
  assert.equal(result.allTime.outputTokens, 20);
  assert.equal(result.allTime.cacheReadTokens, 10);
  assert.equal(result.allTime.unclassifiedTokens, 75);
  assert.equal(result.allTime.clientOutputs.codex, 20);
  assert.equal(result.allTime.modelOutputs['partial-model'], 20);
  assert.equal(result.allTime.modelUnclassifiedTokens['partial-model'], 70);
  assert.equal(result.allTime.sessions['codex:partial'], undefined, 'without matching whole dated evidence old allocation remains unknown');
});

test('healthy native watch keeps unknown old components and sessions while transient Today advances', async t => {
  const fixture = pricedLegacyFixture([{ client: 'codex', sessionId: 'unknown-old', model: 'old-model', totalTokens: 100, cost: 1 }]);
  const options = runtime(t, 'codex');
  let projection, anchor;
  await collectUsageOnce({ ...options, now, sessionUsageArchive: fixture.prior,
    runTokscale: async ({ flags }) => ({ entries: [{ client: 'codex', sessionId: 'new', model: 'new-model',
      input: flags.includes('--today') ? 5 : 25, cost: flags.includes('--today') ? 0.5 : 2.5 }] }),
    runGraph: async () => fixture.input, onSourceArchiveComputed: value => { projection = value; },
    onAnchorComputed: value => { anchor = value; } });
  const bytes = fs.readFileSync(options.dailyHistoryArchiveOptions.path, 'utf8');
  const watched = await collectUsageOnce({ ...options, now: later(2), includeHistory: false, sourceArchiveSnapshot: projection,
    todayOnlyAnchor: { ...anchor.windowsPeriods, dateKey: todayKey, todayPartitions: anchor.todayPartitions, nativeRawPresence: anchor.nativeRawPresence },
    runTokscale: async ({ flags }) => { assert.deepEqual(flags, ['--today']); return { entries: [
      { client: 'codex', sessionId: 'new', model: 'new-model', input: 7, cost: 0.7 }] }; },
    getSessionUsageArchive: () => { throw new Error('watch does not reacquire generic evidence'); } });
  assert.equal(watched.today.totalTokens, 7);
  for (const name of ['month', 'allTime']) {
    assert.equal(watched[name].totalTokens, 107);
    assert.equal(Object.values(watched[name].sessions).reduce((sum, session) => sum + session.totalTokens, 0), 107);
    assert.equal(watched[name].capabilities.tokenComponents, false);
    assert.ok(watched[name].unclassifiedTokens >= 100);
    assert.equal(watched[name].clientUnclassifiedTokens.codex, 100);
    assert.equal(watched[name].modelUnclassifiedTokens['old-model'], 100);
    assert.equal(watched[name].sessions['codex:unknown-old'].inputTokens, 0);
    assert.equal(watched[name].sessions['codex:new'].inputTokens, 7, 'new native input has its own exact provenance');
  }
  assert.equal(fs.readFileSync(options.dailyHistoryArchiveOptions.path, 'utf8'), bytes);
  assert.equal(fixture.display(roundTrip(JSON.parse(bytes))).allTime.totalTokens, 105);
});

test('selected dated legacy100 plus actual Today5 preserves session, cost, model and component allocation through reload/fallback', () => {
  const fixture = datedLegacyFixture();
  let archive = captureDailyHistoryArchive({}, fixture.input, fixture.options);
  const assertAllocated = result => {
    assert.equal(result.today.totalTokens, 5);
    for (const name of ['month', 'allTime']) {
      assert.equal(result[name].totalTokens, 105);
      assert.equal(result[name].costUsd, 4.5);
      assert.deepEqual(result[name].models, { 'old-model': 100, 'new-model': 5 });
      assert.deepEqual(result[name].modelCosts, { 'old-model': 4, 'new-model': 0.5 });
      assert.equal(result[name].sessions['codex:old'].totalTokens, 100);
      assert.equal(result[name].sessions['codex:new'].totalTokens, 5);
      assert.equal(Object.values(result[name].sessions).reduce((sum, session) => sum + session.costUsd, 0), 4.5);
      assert.equal(result[name].outputTokens, 20);
      assert.equal(result[name].cacheReadTokens, 10);
    }
    assert.equal(result.history.summary.totalTokens, 105, 'allocations are not an extra History fold');
  };
  assertAllocated(fixture.display(archive));
  archive = roundTrip(archive);
  assertAllocated(fixture.display(archive));
  archive = roundTrip(captureDailyHistoryArchive(archive, { contributions: [], meta: { generatedAt: later(1).toISOString() } }, fixture.options));
  assertAllocated(fixture.display(archive));
  const original = structuredClone(fixture.prior.sessions['codex:old'].periods.allTime);
  const recaptured = updateSessionUsageArchive(structuredClone(fixture.prior), fixture.display(archive), now).archive;
  assert.deepEqual(recaptured.sessions['codex:old'].periods.allTime, original);
  assert.equal(recaptured.sessions['codex:new'], undefined, 'the generic store is not a second allocation lane');
  assert.equal(archive.sourceLedger.scopes.codex.mode, 'legacy');
  assert.deepEqual(archive.sourceLedger.scopes.codex.events, {});
});

test('healthy cross-day watch selects native Today7 for107 without persisting a new full observation; partial/fallback stays105', async t => {
  const fixture = datedLegacyFixture();
  const options = runtime(t, 'codex');
  let projection, anchor;
  const full = async (clock, input = fixture.input) => collectUsageOnce({ ...options, now: clock, sessionUsageArchive: fixture.prior,
    runTokscale: async ({ flags }) => ({ entries: [{ client: 'codex', sessionId: 'new', model: 'new-model',
      input: flags.includes('--today') ? 5 : 25, cost: flags.includes('--today') ? 0.5 : 2.5 }] }), runGraph: async () => input,
    onSourceArchiveComputed: value => { projection = value; }, onAnchorComputed: value => { anchor = value; } });
  const accepted = await full(now);
  assert.equal(accepted.allTime.totalTokens, 105);
  const bytes = fs.readFileSync(options.dailyHistoryArchiveOptions.path, 'utf8');
  const watch = async () => collectUsageOnce({ ...options, now: later(2), includeHistory: false, sourceArchiveSnapshot: projection,
    todayOnlyAnchor: { ...anchor.windowsPeriods, dateKey: todayKey, todayPartitions: anchor.todayPartitions, nativeRawPresence: anchor.nativeRawPresence },
    runTokscale: async ({ flags }) => { assert.deepEqual(flags, ['--today']); return { entries: [
      { client: 'codex', sessionId: 'new', model: 'new-model', input: 7, cost: 0.7 }] }; },
    getSessionUsageArchive: () => { throw new Error('watch does not acquire migration evidence'); } });
  const growing = await watch();
  for (const name of ['month', 'allTime']) {
    assert.equal(growing[name].totalTokens, 107);
    assert.equal(Object.values(growing[name].sessions).reduce((sum, session) => sum + session.totalTokens, 0), 107);
    assert.equal(growing[name].sessions['codex:new'].totalTokens, 7);
    assert.equal(growing[name].costUsd, 4.7);
  }
  assert.equal(growing.today.totalTokens, 7);
  assert.equal(fs.readFileSync(options.dailyHistoryArchiveOptions.path, 'utf8'), bytes, 'watch is transient');
  assert.equal(fixture.display(roundTrip(JSON.parse(bytes))).allTime.totalTokens, 105);
  const partial = structuredClone(fixture.input);
  partial.sourceUsage.capturedAt = later(3).toISOString();
  partial.sourceUsage.scopes[0].readStatus = 'partial';
  await full(later(3), partial);
  assert.equal((await watch()).allTime.totalTokens, 105);
  const fallback = { contributions: [], meta: { generatedAt: later(4).toISOString() } };
  await full(later(4), fallback);
  assert.equal((await watch()).allTime.totalTokens, 105);
});

test('same SID allocations on disjoint real days merge once, with actual month/timezone windows', () => {
  const fixture = datedLegacyFixture(new Date(2026, 10, 1, 12), 'old');
  const archive = roundTrip(captureDailyHistoryArchive({}, fixture.input, fixture.options));
  const result = fixture.display(archive);
  assert.equal(result.today.sessions['codex:old'].totalTokens, 5);
  assert.equal(result.month.sessions['codex:old'].totalTokens, 5);
  assert.equal(result.allTime.sessions['codex:old'].totalTokens, 105);
  assert.equal(result.allTime.sessions['codex:old'].costUsd, 4.5);
  assert.deepEqual(result.allTime.sessions['codex:old'].models, { 'old-model': 100, 'new-model': 5 });
  for (const zone of ['Pacific/Kiritimati', 'Etc/GMT+12']) {
    const rebucketed = fixture.display(archive, { calendar: { timeZone: zone } });
    assert.equal(rebucketed.allTime.totalTokens, 105, 'dated legacy has no invented UTC time to rebucket');
    assert.equal(rebucketed.month.totalTokens, 5);
    assert.equal(rebucketed.history.summary.totalTokens, 105);
  }
});

test('same-day competition retains one whole token/cost/model/session winner, including cost-only and zero rows', () => {
  const fixture = datedLegacyFixture();
  let archive = captureDailyHistoryArchive({}, fixture.input, fixture.options);
  const oldDate = localTodayKey(fixture.oldDay);
  const nextPrior = structuredClone(fixture.prior);
  const old = nextPrior.sessions['codex:old'];
  for (const session of Object.values(old.periods)) {
    session.costUsd = 8; session.modelCosts = { replacement: 8 }; session.models = { replacement: 100 };
  }
  const costOnly = { ...old.periods.today, sessionId: 'cost-only', totalTokens: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, costUsd: 2, models: {}, modelCosts: { fee: 2 } };
  nextPrior.sessions['codex:cost-only'] = { ...old, sessionId: 'cost-only', periods: { today: costOnly, month: costOnly, allTime: costOnly } };
  const zero = { ...costOnly, sessionId: 'zero', costUsd: 0, modelCosts: {} };
  nextPrior.sessions['codex:zero'] = { ...old, sessionId: 'zero', periods: { today: zero, month: zero, allTime: zero } };
  const next = structuredClone(fixture.input); next.sourceUsage.capturedAt = later(1).toISOString();
  archive = roundTrip(captureDailyHistoryArchive(archive, next, { ...fixture.options, sessionUsageArchive: nextPrior }));
  const selected = archive.sourceLedger.scopes.codex.legacyDays[oldDate];
  assert.equal(selected.sessionAllocation['codex:old'].costUsd, 8);
  assert.equal(selected.sessionAllocation['codex:cost-only'].costUsd, 2);
  assert.equal(selected.sessionAllocation['codex:zero'].totalTokens, 0);
  const result = fixture.display(archive);
  assert.equal(result.allTime.totalTokens, 105);
  assert.equal(result.allTime.costUsd, 10.5, 'allocated tie picks its coherent greater cost');
  assert.deepEqual(result.allTime.modelCosts, { replacement: 8, fee: 2, 'new-model': 0.5 });
  assert.deepEqual(result.allTime.models, { replacement: 100, 'new-model': 5 });
  assert.equal(result.allTime.sessions['codex:cost-only'].costUsd, 2);
  assert.ok(result.allTime.sessions['codex:zero']);
});

test('R3 allocation recovery requires an intact matching dated observation, never matching totals or undated allTime', () => {
  const fixture = datedLegacyFixture();
  const archive = JSON.parse(JSON.stringify(captureDailyHistoryArchive({}, fixture.input, fixture.options)));
  const scope = archive.sourceLedger.scopes.codex;
  for (const day of Object.values(scope.legacyDays)) delete day.sessionAllocation;
  const compatible = roundTrip(archive);
  assert.equal(fixture.display(compatible).today.sessions['codex:new'].totalTokens, 5, 'intact dated Today evidence recovers');
  assert.deepEqual(compatible.sourceLedger.scopes.codex.legacyDays[localTodayKey(fixture.oldDay)].sessionAllocation, undefined,
    'allTime old100 is not yesterday evidence once its dated period is no longer retained');
  const different = structuredClone(archive);
  different.sourceLedger.scopes.codex.legacyPeriods.today.period.modelCosts = { unrelated: 0.5 };
  different.sourceLedger.scopes.codex.legacyPeriods.today.period.clientModelCosts = { codex: { unrelated: 0.5 } };
  const mismatch = roundTrip(different);
  assert.equal(mismatch.sourceLedger.scopes.codex.legacyDays[todayKey].sessionAllocation, undefined);
  const recaptured = roundTrip(captureDailyHistoryArchive(archive, { ...fixture.input,
    sourceUsage: { ...fixture.input.sourceUsage, capturedAt: later(1).toISOString() } }, fixture.options));
  assert.equal(fixture.display(recaptured).allTime.sessions['codex:old'].totalTokens, 100, 'matching real generic Yesterday can recover after acquisition');
  const unavailable = roundTrip(captureDailyHistoryArchive(archive, { ...fixture.input,
    sourceUsage: { ...fixture.input.sourceUsage, capturedAt: later(1).toISOString() } }, { ...fixture.options, sessionUsageArchive: undefined, nativePeriods: undefined }));
  assert.equal(fixture.display(unavailable).allTime.sessions['codex:old'], undefined, 'no fabricated legacy allocation');
});

test('equal-token allocated repricing selects one complete cost observation rather than mixing session/model maxima', () => {
  const fixture = datedLegacyFixture();
  fixture.options.nativePeriods.today = fixture.period(0, 'fee', 'fee-model', 2);
  const archive = roundTrip(captureDailyHistoryArchive({}, fixture.input, fixture.options));
  const result = fixture.display(archive);
  assert.equal(result.allTime.totalTokens, 100, 'dated100 plus cost-only Today has no invented tokens');
  assert.equal(result.allTime.costUsd, 6, 'token tie selects the dated whole observation with greater cost');
  assert.deepEqual(result.allTime.modelCosts, { 'old-model': 4, 'fee-model': 2 });
  assert.equal(result.allTime.sessions['codex:old'].costUsd, 4);
  assert.equal(result.allTime.sessions['codex:fee'].costUsd, 2);
  assert.equal(result.today.sessions['codex:fee'].totalTokens, 0);
  assert.equal(result.history.summary.totalTokens, 100);
});

test('persisted day allocations scrub metadata; malformed optional allocation keeps accounting owned and unknown', () => {
  const fixture = datedLegacyFixture();
  const raw = JSON.parse(JSON.stringify(captureDailyHistoryArchive({}, fixture.input, fixture.options)));
  const oldDay = localTodayKey(fixture.oldDay);
  const allocation = raw.sourceLedger.scopes.codex.legacyDays[oldDay].sessionAllocation;
  Object.assign(allocation['codex:old'], { sourcePath: '/private/secret-rollout', title: 'PRIVATE-TEXT',
    liveActivity: { observedAt: now.toISOString() }, waitingForInput: true, promptCache: { observedAt: now.toISOString(), ttlSeconds: 300 } });
  const clean = roundTrip(raw);
  assert.ok(!JSON.stringify(clean.sourceLedger).includes('PRIVATE-TEXT'));
  assert.ok(!JSON.stringify(clean.sourceLedger).includes('/private/secret-rollout'));
  const displayed = fixture.display(clean);
  const payload = JSON.stringify(serializeSyncPayload({ deviceId: 'test', ...displayed }));
  assert.ok(!payload.includes('sessionAllocation'));
  assert.ok(!payload.includes('sourceLedger'));
  for (const corruption of ['key', 'counter', 'array', 'allocation-total', 'allocation-cost', 'allocation-model']) {
    const invalid = structuredClone(raw);
    const day = invalid.sourceLedger.scopes.codex.legacyDays[oldDay];
    if (corruption === 'key') day.sessionAllocation = { 'codex:wrong': allocation['codex:old'] };
    else if (corruption === 'counter') day.sessionAllocation['codex:old'].totalTokens = '100';
    else if (corruption === 'array') day.sessionAllocation = [];
    else if (corruption === 'allocation-total') day.sessionAllocation['codex:old'].totalTokens = 999;
    else if (corruption === 'allocation-cost') day.sessionAllocation['codex:old'].costUsd = 9;
    else day.sessionAllocation['codex:old'].models = { unrelated: 100 };
    const normalized = roundTrip(invalid);
    assert.equal(normalized.sourceLedger.scopes.codex.legacyDays[oldDay].sessionAllocation, undefined);
    const result = fixture.display(normalized);
    assert.equal(result.allTime.totalTokens, 105);
    assert.equal(result.history.summary.totalTokens, 105);
    assert.equal(result.allTime.sessions['codex:old'], undefined, 'malformed attribution is not fabricated from allTime');
    assert.equal(result.allTime.sessions['codex:new'].totalTokens, 5);
    assert.deepEqual(result.sessionArchiveSource.ownedClients, ['codex']);
  }
});

test('growing legacy counters preserve decorated untouched native metadata in every display period and anchor', () => {
  const prior = generic([row('codex', 'old', 100)]);
  const codex = row('codex', 'new', 150);
  const claudePeriod = extractUsageFromTokscale({ entries: [{ client: 'claude', sessionId: 'live', model: 'model',
    provider: 'provider', input: 10, output: 2, cost: 0.12 }] });
  const input = summary([codex]);
  for (const name of ['today', 'month', 'allTime']) input[name] = extractUsageFromTokscale({ entries: [...native([codex]).entries,
    { client: 'claude', sessionId: 'live', model: 'model', provider: 'provider', input: 10, output: 2, cost: 0.12 }] });
  const fields = { title: 'Decorated', contextTokens: 17, contextWindow: 100,
    startedAt: now.toISOString(), lastUsedAt: now.toISOString(), projectId: 'project',
    promptCache: { observedAt: now.toISOString(), ttlSeconds: 300 }, timedDurationMs: 43, timedOutputTokens: 2 };
  for (const name of ['today', 'month', 'allTime']) Object.assign(input[name].sessions['claude:live'], fields);
  const nativePeriods = structuredClone(input);
  const rawPartitions = Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, {
    codex: extractUsageFromTokscale(native([codex])), claude: structuredClone(claudePeriod) }]));
  const archive = captureDailyHistoryArchive({}, graph([codex]), { ...calendar, sessionUsageArchive: prior, nativePeriods });
  const source = graphFromDailyHistoryArchive([], archive, calendar).sourceUsage;
  applySourceDailyUsage(input, source, { ...calendar, nativePeriods, nativeRawPartitions: rawPartitions });
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(input[name].totalTokens, 162);
    for (const [field, value] of Object.entries(fields)) {
      assert.deepEqual(input[name].sessions['claude:live'][field], value, `${name} display ${field}`);
      assert.deepEqual(nativePeriods[name].sessions['claude:live'][field], value, `${name} anchor ${field}`);
    }
    assert.equal(nativePeriods[name].totalTokens, 162, 'anchor holds only native observation');
  }
});

for (const key of ['__proto__', 'constructor', 'prototype', 'codex:wrong']) test(`strict SQL, JSON and direct evidence reject corrupted key ${key} without losing its row`, async t => {
  const options = runtime(t, 'codex');
  const storeOptions = { path: path.join(options.homeDir, 'generic.json'), databasePath: path.join(options.homeDir, 'generic.sqlite') };
  const prior = generic([row('codex', 'old', 100)]);
  const evidence = JSON.parse(JSON.stringify({ version: 1, sessions: { [key]: prior.sessions['codex:old'] } }));
  assert.equal(isSessionUsageArchiveEvidence(evidence), false);
  const fresh = row('codex', 'new', 15);
  const direct = captureDailyHistoryArchive({}, graph([fresh]), { ...calendar, sessionUsageArchive: evidence });
  assert.deepEqual(direct.sourceLedger.scopes, {});
  assert.equal(Object.keys(evidence.sessions).length, 1);
  const bytes = JSON.stringify(evidence);
  fs.writeFileSync(storeOptions.path, bytes);
  assert.throws(() => readSessionUsageArchiveEvidence(storeOptions), /invalid session archive migration evidence/);
  assert.equal(fs.readFileSync(storeOptions.path, 'utf8'), bytes);
  fs.unlinkSync(storeOptions.path);
  const store = createSessionUsageArchiveStore(storeOptions);
  try {
    store.capture(summary([row('codex', 'old', 100)]), now);
    const db = new DatabaseSync(storeOptions.databasePath);
    try { db.prepare('UPDATE sessions SET session_key = ?').run(key); } finally { db.close(); }
    assert.throws(() => store.readMigrationEvidence(), /invalid session archive migration evidence/);
    let projection;
    await collectUsageOnce({ ...options, now, getSessionUsageArchive: () => store.readMigrationEvidence(),
      runTokscale: async () => native([fresh]), runGraph: async () => graph([fresh]), onSourceArchiveComputed: value => { projection = value; } });
    assert.deepEqual(projection.ownedClients, []);
    const read = new DatabaseSync(storeOptions.databasePath, { readOnly: true });
    try { assert.equal(read.prepare('SELECT entry_json FROM sessions WHERE session_key = ?').get(key).entry_json,
      JSON.stringify(prior.sessions['codex:old'])); } finally { read.close(); }
  } finally { store.close(); }
});

test('evidence validation rejects prototype-lost rows and mismatched entry identity while preserving established accounting', async t => {
  const options = runtime(t, 'codex');
  const prior = generic([row('codex', 'old', 100)]);
  const inherited = {};
  inherited.__proto__ = prior.sessions['codex:old'];
  assert.equal(isSessionUsageArchiveEvidence({ version: 1, sessions: inherited }), false);
  const corrupt = structuredClone(prior);
  corrupt.sessions['codex:old'].sessionId = 'changed';
  for (const period of Object.values(corrupt.sessions['codex:old'].periods)) period.sessionId = 'changed';
  assert.equal(isSessionUsageArchiveEvidence(corrupt), false);
  const higher = row('codex', 'A', 45);
  const lower = row('codex', 'A', 15);
  await collectUsageOnce({ ...options, now, runTokscale: async () => native([higher]), runGraph: async () => graph([higher]) });
  let cache;
  const rejected = await collectUsageOnce({ ...options, now: later(1), sessionUsageArchive: corrupt,
    runTokscale: async () => native([lower]), runGraph: async () => graph([lower], later(1), { codex: 'partial' }),
    onSourceArchiveComputed: value => { cache = value; } });
  assertCounters(rejected, 45);
  const watch = await collectUsageOnce({ ...options, now: later(2), includeHistory: false, sourceArchiveSnapshot: cache,
    runTokscale: async () => native([lower]) });
  for (const name of ['today', 'month', 'allTime']) assert.equal(watch[name].totalTokens, 45);
});

test('a safe canonical key containing SID __proto__ and null-prototype evidence maps preserve retained counters', t => {
  const options = runtime(t, 'codex');
  const prior = generic([row('codex', '__proto__', 100)]);
  prior.sessions = Object.assign(Object.create(null), prior.sessions);
  assert.equal(isSessionUsageArchiveEvidence(prior), true);
  const inherited = Object.create({ 'codex:hidden': generic([row('codex', 'hidden', 100)]).sessions['codex:hidden'] });
  Object.assign(inherited, prior.sessions);
  assert.equal(isSessionUsageArchiveEvidence({ version: 1, sessions: inherited }), false);
  const archive = captureDailyHistoryArchive({}, graph([row('codex', 'new', 15)]), { ...calendar, sessionUsageArchive: prior });
  assertCounters(project(roundTrip(archive)), 100);
  assert.equal(archive.sourceLedger.scopes.codex.mode, 'legacy');
  const storeOptions = { path: path.join(options.homeDir, 'generic.json'), databasePath: path.join(options.homeDir, 'generic.sqlite') };
  fs.writeFileSync(storeOptions.path, JSON.stringify(prior));
  assert.equal(readSessionUsageArchiveEvidence(storeOptions).sessions['codex:__proto__'].periods.allTime.totalTokens, 100);
  const store = createSessionUsageArchiveStore(storeOptions);
  try {
    store.read(now);
    assert.equal(store.readMigrationEvidence().sessions['codex:__proto__'].periods.allTime.totalTokens, 100);
  } finally { store.close(); }
});

test('production collector getter reads retained SQLite evidence before acceptance and is absent from cached watch', async t => {
  const options = runtime(t, 'codex');
  const store = createSessionUsageArchiveStore({ databasePath: path.join(options.homeDir, 'sessions.sqlite'),
    path: path.join(options.homeDir, 'sessions.json') });
  try {
    store.capture(summary([row('codex', 'unknown-old-ID', 100)]), now);
    let reads = 0;
    let cache;
    const fresh = row('codex', 'new-ID', 20);
    const getter = () => { reads++; return store.refresh(); };
    const first = await collectUsageOnce({ ...options, now, getSessionUsageArchive: getter,
      runTokscale: async () => native([fresh]), runGraph: async () => graph([fresh]),
      onSourceArchiveComputed: value => { cache = value; } });
    assert.equal(reads, 1);
    assertCounters(applySessionUsageArchive(first, store.capture(first, now).archive, { now }), 100);
    assert.equal(store.refresh().sessions['codex:unknown-old-ID'].periods.allTime.totalTokens, 100);
    const watch = await collectUsageOnce({ ...options, now: later(1), includeHistory: false,
      sourceArchiveSnapshot: cache, getSessionUsageArchive: () => { throw new Error('watch must not read retained generic ledger'); },
      runTokscale: async () => native([fresh]) });
    for (const name of ['today', 'month', 'allTime']) assert.equal(watch[name].totalTokens, 100);
    assert.equal(reads, 1);
  } finally {
    store.close();
  }
});

test('unavailable generic getter preserves accepted45, persists partial watch lock, and permits later valid lower correction', async t => {
  const options = runtime(t, 'codex');
  let cache;
  const first = await collectUsageOnce({ ...options, now,
    runTokscale: async () => native([row('codex', 'A', 45)]), runGraph: async () => graph([row('codex', 'A', 45)]),
    onSourceArchiveComputed: value => { cache = value; } });
  assertCounters(first, 45);
  const unavailable = async () => { throw new Error('retained generic store unavailable'); };
  const lower = row('codex', 'A', 15);
  const rejected = await collectUsageOnce({ ...options, now: later(1), sourceArchiveSnapshot: cache,
    getSessionUsageArchive: unavailable, runTokscale: async () => native([lower]),
    logger: () => { throw new Error('diagnostic observer unavailable'); },
    runGraph: async () => graph([lower], later(1), { codex: 'partial' }),
    onSourceArchiveComputed: value => { cache = value; } });
  assertCounters(rejected, 45);
  assert.deepEqual(rejected.sessionArchiveSource.ownedClients, ['codex']);
  const disk = JSON.parse(fs.readFileSync(options.dailyHistoryArchiveOptions.path));
  assert.equal(disk.sourceLedger.scopes.codex.blockNativeWatch, true);
  const watch = await collectUsageOnce({ ...options, now: later(2), includeHistory: false,
    sourceArchiveSnapshot: cache, getSessionUsageArchive: unavailable, runTokscale: async () => native([lower]) });
  for (const name of ['today', 'month', 'allTime']) assert.equal(watch[name].totalTokens, 45);
  const accepted = await collectUsageOnce({ ...options, now: later(3), getSessionUsageArchive: unavailable,
    runTokscale: async () => native([lower]), runGraph: async () => graph([lower], later(3)) });
  assertCounters(accepted, 15);
  assert.equal(JSON.parse(fs.readFileSync(options.dailyHistoryArchiveOptions.path)).sourceLedger.scopes.codex.blockNativeWatch, undefined);
});

test('unavailable generic getter blocks the first unproven migration instead of assuming an empty archive', async t => {
  const options = runtime(t, 'codex');
  let projection;
  const fresh = row('codex', 'new', 15);
  const result = await collectUsageOnce({ ...options, now,
    getSessionUsageArchive: () => { throw new Error('retained generic store unavailable'); },
    runTokscale: async () => native([fresh]), runGraph: async () => graph([fresh]),
    onSourceArchiveComputed: value => { projection = value; } });
  assert.deepEqual(projection.ownedClients, []);
  assert.equal(result.allTime.totalTokens, 15, 'ordinary unowned native legacy observation');
  const disk = JSON.parse(fs.readFileSync(options.dailyHistoryArchiveOptions.path));
  assert.deepEqual(disk.sourceLedger.scopes, {});
  assert.equal(disk.sourceLedger.observations.codex.reason, 'retained-evidence-unavailable');
});

test('partial read at the accepted timestamp still locks watch when its exported counters repeat45', async t => {
  const options = runtime(t, 'codex');
  const higher = row('codex', 'A', 45);
  const lower = row('codex', 'A', 15);
  await collectUsageOnce({ ...options, now, runTokscale: async () => native([higher]), runGraph: async () => graph([higher]) });
  let cache;
  const rejected = await collectUsageOnce({ ...options, now, runTokscale: async () => native([lower]),
    runGraph: async () => graph([higher], now, { codex: 'partial' }), onSourceArchiveComputed: value => { cache = value; } });
  assertCounters(rejected, 45);
  assert.equal(cache.scopes[0].blockNativeWatch, true);
  const watch = await collectUsageOnce({ ...options, now: later(1), includeHistory: false, sourceArchiveSnapshot: cache,
    runTokscale: async () => native([lower]) });
  for (const name of ['today', 'month', 'allTime']) assert.equal(watch[name].totalTokens, 45);
});

test('allTime-only generic evidence stays unallocated instead of fabricating a day from capturedAt', () => {
  const prior = generic([row('codex', 'unknown-old-ID', 100)]);
  const entry = prior.sessions['codex:unknown-old-ID'];
  delete entry.periods.today;
  delete entry.periods.month;
  delete entry.periodWindows.today;
  delete entry.periodWindows.month;
  delete entry.day;
  delete entry.month;
  const fresh = row('codex', 'new-ID', 20);
  const archive = roundTrip(captureDailyHistoryArchive({}, graph([fresh]), { ...calendar, sessionUsageArchive: prior }));
  const result = project(archive, [fresh]);
  assert.equal(result.allTime.totalTokens, 100);
  assert.equal(result.allTime.sessions['codex:unknown-old-ID'].totalTokens, 100);
  assert.equal(result.today.totalTokens, 0);
  assert.equal(result.history.summary.totalTokens, 0);
  assert.deepEqual(archive.sourceLedger.scopes.codex.legacyDays, {});
  assert.equal(archive.sourceLedger.scopes.codex.mode, 'legacy');
  assert.equal(updateSessionUsageArchive(prior, result, now).archive.sessions['codex:unknown-old-ID'].periods.allTime.totalTokens, 100);
});

test('whole native legacy observations can advance counters without migrating or inventing an additive union', async t => {
  const options = runtime(t, 'codex');
  const prior = generic([row('codex', 'old', 10)]);
  const fresh = row('codex', 'new', 20);
  const result = await collectUsageOnce({ ...options, now, sessionUsageArchive: prior,
    runTokscale: async () => native([fresh]), runGraph: async () => graph([fresh]) });
  assertCounters(applySessionUsageArchive(result, prior, { now }), 20);
  const disk = JSON.parse(fs.readFileSync(options.dailyHistoryArchiveOptions.path));
  assert.equal(disk.sourceLedger.scopes.codex.mode, 'legacy');
  assert.equal(prior.sessions['codex:old'].periods.allTime.totalTokens, 10);
});

test('released canonical MiMo history blocks raw migration without renaming exact domains or inferring ownership', () => {
  const previous = summary([row('mimo', 'old', 45)]);
  const retainedSessions = captureSessionUsageArchive({}, previous, now);
  const live = captureLiveDailyHistory({}, previous.today, calendar);
  const legacy = { version: 1, days: live.liveDays };
  const incoming = graph([row('micode', 'old', 45, 'opaque-shared-mimo')], later(1));
  incoming.sourceUsage.scopes[0].clients.push('micode-desktop');
  incoming.sourceUsage.replacementClients.push('micode-desktop');
  const archive = roundTrip(captureDailyHistoryArchive(legacy, incoming, { ...calendar, sessionUsageArchive: retainedSessions }));
  assert.deepEqual(Object.keys(archive.sourceLedger.scopes), ['opaque-shared-mimo']);
  assert.equal(archive.sourceLedger.scopes['opaque-shared-mimo'].reason, 'unresolved-legacy-boundary');
  assertCounters(project(archive), 45);
  const nativeRawPartitions = Object.fromEntries(['today', 'month', 'allTime'].map(name => [name,
    { micode: summary([row('micode', 'old', 45)])[name] }]));
  assertCounters(project(archive, [row('micode', 'old', 45)], { nativeRawPartitions,
    nativeRawPresence: Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, ['micode:old']])) }), 45);
  const rawWatch = project(archive, [row('micode', 'old', 45)], { replaceLive: false, nativeRawPartitions,
    nativeRawPresence: Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, ['micode:old']])) });
  assertCounters(rawWatch, 45);
  const independent = captureDailyHistoryArchive({}, graph([row('devin-cli', 'same', 45, 'raw-one'),
    row('devin-desktop', 'same', 45, 'raw-two')]), calendar);
  assert.deepEqual(Object.keys(independent.sourceLedger.scopes), ['raw-one', 'raw-two']);
  assert.equal(independent.sourceLedger.scopes['raw-one'].events['event:same'].ownerKey, 'devin-cli:same');
  assert.equal(independent.sourceLedger.scopes['raw-two'].events['event:same'].ownerKey, 'devin-desktop:same');
  assertCounters(project(independent), 90);
});

test('changed rejected scope locks every raw overlap through reload, fallback and watch until valid complete scope accepts', () => {
  const initial = captureDailyHistoryArchive({}, graph([row('claude', 'A', 45, 'S1')]), calendar);
  let archive = roundTrip(captureDailyHistoryArchive(initial, graph([row('claude', 'A', 15, 'S2')], later(1)), calendar));
  assert.equal(archive.sourceLedger.scopes.S1.reason, 'scope-identity-change');
  assert.equal(archive.sourceLedger.scopes.S1.blockNativeWatch, true);
  const watch = project(archive, [row('claude', 'A', 15)], { replaceLive: false, nativeAnchor: summary([row('claude', 'A', 45)]) });
  assertCounters(watch, 45);
  archive = roundTrip(captureDailyHistoryArchive(archive, { contributions: [], meta: { generatedAt: later(2).toISOString() } }, calendar));
  assert.equal(archive.sourceLedger.scopes.S1.blockNativeWatch, true);
  const valid = captureDailyHistoryArchive(archive, graph([row('claude', 'A', 15, 'S1')], later(3)), calendar);
  assert.equal(valid.sourceLedger.scopes.S1.blockNativeWatch, undefined);
  const healthyWatch = project(valid, [row('claude', 'A', 25)], { replaceLive: false, nativeAnchor: summary([row('claude', 'A', 15)]) });
  for (const name of ['today', 'month', 'allTime']) assert.equal(healthyWatch[name].totalTokens, 25);
  const two = captureDailyHistoryArchive({}, graph([row('claude', 'A', 45, 'S1'), row('codex', 'B', 30, 'S3')]), calendar);
  const rejected = captureDailyHistoryArchive(two, graph([row('claude', 'A', 15, 'new'), row('codex', 'B', 10, 'new')], later(1)), calendar);
  for (const id of ['S1', 'S3']) assert.equal(rejected.sourceLedger.scopes[id].blockNativeWatch, true);
});

test('same-canonical native raw client without a scanner scope prevents initial migration', async t => {
  const options = runtime(t, 'devin');
  const cli = row('devin-cli', 'A', 30);
  const desktop = row('devin-desktop', 'B', 20);
  let projection;
  const result = await collectUsageOnce({ ...options, now,
    runTokscale: async () => native([cli, desktop]), runGraph: async () => graph([cli]),
    onSourceArchiveComputed: value => { projection = value; } });
  assert.deepEqual(projection.ownedClients, []);
  assertCounters(result, 50);
  const partialGraph = graph([cli]);
  partialGraph.contributions.push(...graph([desktop]).contributions);
  const direct = captureDailyHistoryArchive({}, partialGraph, calendar);
  assert.deepEqual(direct.sourceLedger.scopes, {}, 'ordinary graph rows also expose an uninstrumented canonical peer');
  const sinceFuture = await collectUsageOnce({ ...options, now, allTimeSince: '2027-01-01',
    runTokscale: async ({ since }) => since ? native([]) : native([cli, desktop]), runGraph: async () => graph([cli]),
    onSourceArchiveComputed: value => { projection = value; } });
  assert.deepEqual(projection.ownedClients, [], 'Today/month raw presence also protects the canonical boundary');
  assert.equal(sinceFuture.today.totalTokens, 50);
});

for (const status of ['partial', 'uninstrumented']) test(`same-canonical ${status} sibling arriving after ownership freezes accepted counters until complete evidence`, async t => {
  const options = runtime(t, 'devin');
  const cli = row('devin-cli', 'A', 30);
  const desktop = row('devin-desktop', 'B', 20);
  let cache;
  await collectUsageOnce({ ...options, now, runTokscale: async () => native([cli]), runGraph: async () => graph([cli]),
    onSourceArchiveComputed: value => { cache = value; } });
  const prior = generic([desktop]);
  const incomplete = status === 'partial' ? graph([cli, desktop], later(1), { 'devin-desktop': 'partial' }) : graph([cli], later(1));
  const rejected = await collectUsageOnce({ ...options, now: later(1), sessionUsageArchive: prior,
    runTokscale: async () => native([cli, desktop]), runGraph: async () => incomplete,
    onSourceArchiveComputed: value => { cache = value; } });
  assertCounters(applySessionUsageArchive(rejected, prior, { now: later(1) }), 30);
  assert.deepEqual(cache.ownedClients, ['devin-cli']);
  assert.equal(cache.scopes[0].blockNativeWatch, true);
  assert.equal(updateSessionUsageArchive(prior, rejected, later(1)).archive.sessions['devin:B'].periods.allTime.totalTokens, 20);
  const watch = await collectUsageOnce({ ...options, now: later(2), includeHistory: false, sourceArchiveSnapshot: cache,
    runTokscale: async () => native([row('devin-cli', 'A', 15), desktop]) });
  for (const name of ['today', 'month', 'allTime']) assert.equal(watch[name].totalTokens, 30);
  const complete = await collectUsageOnce({ ...options, now: later(3), sessionUsageArchive: prior,
    runTokscale: async () => native([cli, desktop]), runGraph: async () => graph([cli, desktop], later(3)) });
  assertCounters(applySessionUsageArchive(complete, prior, { now: later(3) }), 50);
});

for (const evidence of [null, { version: 2, sessions: {} }, { version: 1, sessions: [] },
  { version: 1, sessions: { broken: null } }, { version: 1, sessions: { broken: {} } },
  { version: 1, sessions: { ...generic([row('codex', 'prior', 100)]).sessions, broken: null } }]) test(`getter ${JSON.stringify(evidence)} is unavailable evidence, preserving accepted ownership and blocking first migration`, async t => {
  const options = runtime(t, 'codex');
  const higher = row('codex', 'A', 45);
  const lower = row('codex', 'A', 15);
  await collectUsageOnce({ ...options, now, runTokscale: async () => native([higher]), runGraph: async () => graph([higher]) });
  let cache;
  const rejected = await collectUsageOnce({ ...options, now: later(1), getSessionUsageArchive: () => evidence,
    runTokscale: async () => native([lower]), runGraph: async () => graph([lower], later(1), { codex: 'partial' }),
    onSourceArchiveComputed: value => { cache = value; } });
  assertCounters(rejected, 45);
  assert.deepEqual(rejected.sessionArchiveSource.ownedClients, ['codex']);
  assert.equal(JSON.parse(fs.readFileSync(options.dailyHistoryArchiveOptions.path)).sourceLedger.scopes.codex.blockNativeWatch, true);
  const watch = await collectUsageOnce({ ...options, now: later(2), includeHistory: false, sourceArchiveSnapshot: cache,
    getSessionUsageArchive: () => { throw new Error('cached watch must not reacquire evidence'); },
    runTokscale: async () => native([lower]) });
  for (const name of ['today', 'month', 'allTime']) assert.equal(watch[name].totalTokens, 45);
  const freshOptions = runtime(t, 'codex');
  let projection;
  await collectUsageOnce({ ...freshOptions, now, getSessionUsageArchive: () => evidence,
    runTokscale: async () => native([lower]), runGraph: async () => graph([lower]),
    onSourceArchiveComputed: value => { projection = value; } });
  assert.deepEqual(projection.ownedClients, []);
  const direct = captureDailyHistoryArchive({}, graph([lower]), { ...calendar, sessionUsageArchive: evidence });
  assert.deepEqual(direct.sourceLedger.scopes, {});
  assert.equal(direct.sourceLedger.observations.codex.reason, 'retained-evidence-unavailable');
});

test('strict production fallback distinguishes missing archives from corrupt JSON and recovers without erasing evidence', async t => {
  const options = runtime(t, 'codex');
  const storeOptions = { path: path.join(options.homeDir, 'generic.json'), databasePath: path.join(options.homeDir, 'generic.sqlite') };
  assert.deepEqual(readSessionUsageArchiveEvidence(storeOptions), emptyArchive());
  assert.equal(fs.existsSync(storeOptions.databasePath), false);
  const bytes = '{broken-json';
  fs.writeFileSync(storeOptions.path, bytes);
  assert.throws(() => readSessionUsageArchiveEvidence(storeOptions));
  let projection;
  const fresh = row('codex', 'new', 15);
  await collectUsageOnce({ ...options, now, getSessionUsageArchive: undefined, sessionUsageArchiveOptions: storeOptions,
    runTokscale: async () => native([fresh]), runGraph: async () => graph([fresh]),
    onSourceArchiveComputed: value => { projection = value; } });
  assert.deepEqual(projection.ownedClients, []);
  assert.equal(fs.readFileSync(storeOptions.path, 'utf8'), bytes);
  assert.equal(JSON.parse(fs.readFileSync(options.dailyHistoryArchiveOptions.path)).sourceLedger.observations.codex.reason, 'retained-evidence-unavailable');
  fs.writeFileSync(storeOptions.path, JSON.stringify(emptyArchive()));
  const recovered = await collectUsageOnce({ ...options, now: later(1), getSessionUsageArchive: undefined,
    sessionUsageArchiveOptions: storeOptions, runTokscale: async () => native([fresh]), runGraph: async () => graph([fresh], later(1)) });
  assert.deepEqual(recovered.sessionArchiveSource.ownedClients, ['codex']);
  assertCounters(recovered, 15);
});

test('strict real fallback read failure preserves accepted45 and locks cached watch while blocking first ownership', async t => {
  const options = runtime(t, 'codex');
  const higher = row('codex', 'A', 45);
  const lower = row('codex', 'A', 15);
  await collectUsageOnce({ ...options, now, runTokscale: async () => native([higher]), runGraph: async () => graph([higher]) });
  const storeOptions = { path: path.join(options.homeDir, 'generic.json'), databasePath: path.join(options.homeDir, 'generic.sqlite'),
    readFileSync() { const error = new Error('denied'); error.code = 'EACCES'; throw error; } };
  let cache;
  const rejected = await collectUsageOnce({ ...options, now: later(1), getSessionUsageArchive: undefined,
    sessionUsageArchiveOptions: storeOptions, runTokscale: async () => native([lower]),
    runGraph: async () => graph([lower], later(1), { codex: 'partial' }), onSourceArchiveComputed: value => { cache = value; } });
  assertCounters(rejected, 45);
  assert.deepEqual(rejected.sessionArchiveSource.ownedClients, ['codex']);
  const watch = await collectUsageOnce({ ...options, now: later(2), includeHistory: false, sourceArchiveSnapshot: cache,
    getSessionUsageArchive: () => { throw new Error('watch'); }, runTokscale: async () => native([lower]) });
  for (const name of ['today', 'month', 'allTime']) assert.equal(watch[name].totalTokens, 45);
  const freshOptions = runtime(t, 'codex');
  let projection;
  await collectUsageOnce({ ...freshOptions, now, getSessionUsageArchive: undefined, sessionUsageArchiveOptions: storeOptions,
    runTokscale: async () => native([lower]), runGraph: async () => graph([lower]), onSourceArchiveComputed: value => { projection = value; } });
  assert.deepEqual(projection.ownedClients, []);
});

test('store migration evidence bypasses refresh dropping invalid SQLite rows and preserves accepted ownership', async t => {
  const options = runtime(t, 'codex');
  const storeOptions = { path: path.join(options.homeDir, 'generic.json'), databasePath: path.join(options.homeDir, 'generic.sqlite') };
  const store = createSessionUsageArchiveStore(storeOptions);
  try {
    store.capture(summary([row('codex', 'old', 100)]), now);
    const db = new DatabaseSync(storeOptions.databasePath);
    try { db.prepare('UPDATE sessions SET entry_json = ?, revision = revision + 1').run('null');
      db.prepare("UPDATE metadata SET value = '2' WHERE key = 'revision'").run();
    } finally { db.close(); }
    assert.deepEqual(store.refresh().sessions, {}, 'ordinary display is tolerant');
    assert.throws(() => store.readMigrationEvidence(), /invalid session archive migration evidence/);
    const higher = row('codex', 'A', 45);
    const lower = row('codex', 'A', 15);
    await collectUsageOnce({ ...options, now, runTokscale: async () => native([higher]), runGraph: async () => graph([higher]) });
    let cache;
    const rejected = await collectUsageOnce({ ...options, now: later(1), getSessionUsageArchive: () => store.readMigrationEvidence(),
      runTokscale: async () => native([lower]), runGraph: async () => graph([lower], later(1), { codex: 'partial' }),
      onSourceArchiveComputed: value => { cache = value; } });
    assertCounters(rejected, 45);
    const watch = await collectUsageOnce({ ...options, now: later(2), includeHistory: false, sourceArchiveSnapshot: cache,
      runTokscale: async () => native([lower]) });
    for (const name of ['today', 'month', 'allTime']) assert.equal(watch[name].totalTokens, 45);
    const freshOptions = runtime(t, 'codex');
    let projection;
    await collectUsageOnce({ ...freshOptions, now, getSessionUsageArchive: () => store.readMigrationEvidence(),
      runTokscale: async () => native([lower]), runGraph: async () => graph([lower]), onSourceArchiveComputed: value => { projection = value; } });
    assert.deepEqual(projection.ownedClients, []);
  } finally { store.close(); }
});

test('invalid legacy JSON rows survive store refresh and attempted writer migration', t => {
  const options = runtime(t, 'codex');
  const storeOptions = { path: path.join(options.homeDir, 'generic.json'), databasePath: path.join(options.homeDir, 'generic.sqlite') };
  const bytes = JSON.stringify({ version: 1, sessions: { broken: null } });
  fs.writeFileSync(storeOptions.path, bytes);
  const store = createSessionUsageArchiveStore(storeOptions);
  try {
    assert.deepEqual(store.refresh().sessions, {});
    assert.throws(() => store.readMigrationEvidence(), /invalid session archive migration evidence/);
    assert.ok(store.capture(summary([row('codex', 'A', 15)]), now).error);
    assert.equal(fs.readFileSync(storeOptions.path, 'utf8'), bytes);
    assert.throws(() => store.readMigrationEvidence(), /invalid session archive migration evidence/);
  } finally { store.close(); }
});

test('an unrelated unknown canonical client does not block a complete exact scope', async t => {
  const options = runtime(t, 'claude,codex');
  const claude = row('claude', 'A', 30);
  const codex = row('codex', 'B', 20);
  let projection;
  const result = await collectUsageOnce({ ...options, now,
    runTokscale: async () => native([claude, codex]), runGraph: async () => graph([claude, codex], now, { codex: 'unknown' }),
    onSourceArchiveComputed: value => { projection = value; } });
  assert.deepEqual(projection.ownedClients, ['claude']);
  assertCounters(result, 50);
});

test('retained legacy period evidence scrubs metadata and stays private while the generic original remains intact', () => {
  const prior = generic([row('codex', 'old', 100)]);
  for (const period of Object.values(prior.sessions['codex:old'].periods)) {
    period.title = 'private session title';
    period.sourcePath = '/private/secret/source';
    period.prompt = 'private prompt';
  }
  const archive = roundTrip(captureDailyHistoryArchive({}, graph([row('codex', 'new', 20)]), { ...calendar, sessionUsageArchive: prior }));
  const saved = JSON.stringify(archive.sourceLedger);
  for (const text of ['private session title', '/private/secret/source', 'private prompt']) assert.equal(saved.includes(text), false);
  const result = applySessionUsageArchive(project(archive), prior, { now });
  assert.equal(result.allTime.sessions['codex:old'].title, 'private session title');
  assert.equal(JSON.stringify(serializeSyncPayload(result)).includes('legacyPeriods'), false);
  assert.equal(JSON.stringify(result).includes('sessionArchiveSource'), false);
  assert.equal(prior.sessions['codex:old'].periods.allTime.totalTokens, 100);
});
