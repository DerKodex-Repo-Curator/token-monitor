'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { extractUsageFromTokscale, extractUsageBundleFromTokscale, normalizePeriod, mergePeriods, applyPeriodDelta } = require('../../src/shared/usage');
const { captureDailyHistoryArchive } = require('../../src/shared/dailyHistoryArchive');
const { createSessionUsageArchiveStore } = require('../../src/shared/usage/sessionUsageArchiveStore');
const { createUsageTransform } = require('../../src/shared/usage/usageTransform');

const AT = new Date('2026-07-09T08:15:00Z');
function report(ids = ['gpt-5.5'], model = 'GPT 5.5', input = 100) {
  return { entries: [{ client: 'opencode', sessionId: 'one', model, canonicalModelIds: ids,
    provider: 'openai', input, output: 0, cost: input / 100 }] };
}
function record(period) {
  return { updatedAt: AT.toISOString(), today: normalizePeriod({}), month: structuredClone(period),
    allTime: structuredClone(period), sessionUsageArchiveFullScan: true };
}
function setup(t, models = [['gpt-5.5', 100]]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-model-coverage-'));
  const dailyPath = path.join(dir, 'daily.json');
  fs.writeFileSync(dailyPath, JSON.stringify(captureDailyHistoryArchive({}, { contributions: [{
    date: '2026-07-08', clients: models.map(([modelId, input]) => ({ client: 'opencode', modelId,
      tokens: { input }, cost: input / 100 }))
  }] })));
  const storeOptions = { databasePath: path.join(dir, 'sessions.sqlite'), path: path.join(dir, 'legacy.json') };
  let store = createSessionUsageArchiveStore(storeOptions);
  const transform = () => createUsageTransform({ store, dailyHistoryArchive: { path: dailyPath },
    getSettings: () => ({ clients: 'opencode', projectsEnabled: false, allTimeSince: '2024-01-01' }), log() {} });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, dailyPath, get store() { return store; }, transform,
    reopen() { store.close(); store = createSessionUsageArchiveStore(storeOptions); return transform(); } };
}

for (const label of ['gpt-5.5', 'GPT 5.5', 'native-label']) {
  test(`canonical coverage excludes the same daily usage while preserving display ${label}`, t => {
    const fixture = setup(t);
    const period = extractUsageFromTokscale(report(['gpt-5.5'], label));
    const visible = fixture.transform().transform(record(period));
    assert.equal(visible.allTime.totalTokens, 100);
    assert.equal(visible.allTime.costUsd, 1);
    assert.deepEqual(visible.allTime.models, period.models);
    assert.deepEqual(visible.allTime.modelCosts, period.modelCosts);
    assert.deepEqual(period.clientModelIds.opencode, ['gpt-5.5']);
    assert.equal(fixture.reopen().transform(record(period)).allTime.totalTokens, 100);
  });
}

test('one display row covers multiple canonical IDs without allocating its amount to each ID', t => {
  const fixture = setup(t, [['model-a', 60], ['model-b', 40], ['missing-model', 7]]);
  const period = extractUsageFromTokscale(report(['model-b', 'model-a', 'model-a'], 'Shared Label'));
  assert.deepEqual(period.models, { 'shared label': 100 });
  assert.deepEqual(period.sessions['opencode:one'].models, { 'shared label': 100 });
  assert.deepEqual(period.sessions['opencode:one'].canonicalModelIds, ['model-a', 'model-b']);
  const visible = fixture.transform().transform(record(period));
  assert.equal(visible.allTime.totalTokens, 107);
  assert.equal(visible.allTime.costUsd, 1.07);
  assert.equal(visible.allTime.models['shared label'], 100);
  assert.equal(visible.allTime.models['missing-model'], 7);
  assert.equal(visible.allTime.models['model-a'], undefined);
  assert.equal(visible.allTime.models['model-b'], undefined);
});

test('canonical identity survives client partitions, normalization, merges and a zero-amount watch delta', () => {
  const old = extractUsageBundleFromTokscale(report(['model-a']));
  const fresh = extractUsageBundleFromTokscale(report(['model-b']));
  assert.deepEqual(old.byClient.opencode.clientModelIds.opencode, ['model-a']);
  const delta = applyPeriodDelta(old.period, fresh.period, old.period);
  const normalized = normalizePeriod(delta);
  assert.equal(normalized.totalTokens, 100);
  assert.deepEqual(normalized.clientModelIds.opencode, ['model-a', 'model-b']);
  assert.deepEqual(normalized.sessions['opencode:one'].canonicalModelIds, ['model-a', 'model-b']);
  assert.deepEqual(mergePeriods(old.period, fresh.period).clientModelIds.opencode, ['model-a', 'model-b']);
  assert.deepEqual(normalizePeriod(normalized), normalized);
});

test('same tokens and cost with new canonical coverage commits a new SQLite revision', t => {
  const fixture = setup(t, [['model-a', 100], ['model-b', 100]]);
  const first = record(extractUsageFromTokscale(report(['model-a'])));
  fixture.store.capture(first, AT);
  const second = record(extractUsageFromTokscale(report(['model-a', 'model-b'])));
  const capture = fixture.store.capture(second, new Date(AT.getTime() + 1000));
  const entry = fixture.store.read(AT).sessions['opencode:one'];
  assert.deepEqual(entry.observedModels, ['gpt 5.5', 'model-a', 'model-b']);
  assert.equal(entry.periods.allTime.totalTokens, 100);
  assert.equal(entry.periods.allTime.costUsd, 1);
  assert.equal(capture.error, null);
  assert.equal(capture.changedKeys.has('opencode:one'), true);
  const visible = fixture.reopen().transform(record(normalizePeriod({})));
  assert.equal(visible.allTime.totalTokens, 100);
  assert.equal(visible.allTime.costUsd, 1);
});

test('canonical evidence preserves downward and explicit zero corrections through reopen and an empty scan', t => {
  const fixture = setup(t);
  const values = [];
  let transform = fixture.transform();
  for (const tokens of [120, 20, 0]) {
    const period = normalizePeriod({ totalTokens: tokens, costUsd: tokens / 100,
      clients: { opencode: tokens }, clientCosts: { opencode: tokens / 100 },
      clientModelIds: { opencode: ['gpt-5.5'] },
      sessions: { 'opencode:one': { client: 'opencode', sessionId: 'one', totalTokens: tokens,
        costUsd: tokens / 100, models: { 'display label': tokens }, modelCosts: { 'display label': tokens / 100 },
        canonicalModelIds: ['gpt-5.5'] } } });
    const visible = transform.transform(record(period));
    values.push(visible.allTime.totalTokens);
    assert.equal(visible.allTime.costUsd, tokens / 100);
  }
  transform = fixture.reopen();
  values.push(transform.transform(record(normalizePeriod({}))).allTime.totalTokens);
  assert.deepEqual(values, [120, 20, 0, 0]);
  assert.deepEqual(fixture.store.read(AT).sessions['opencode:one'].observedModels, ['display label', 'gpt-5.5']);
});

test('canonical model coverage works without a session identity', t => {
  const fixture = setup(t);
  const json = report(); delete json.entries[0].sessionId;
  const visible = fixture.transform().transform(record(extractUsageFromTokscale(json)));
  assert.equal(visible.allTime.totalTokens, 100);
  assert.equal(visible.allTime.costUsd, 1);
});

test('archive normalization and stale captures retain canonical, display and cost-only coverage', t => {
  const { normalizeSessionUsageArchive } = require('../../src/shared/usage/sessionUsageArchive');
  const { applyDailyHistoryAllTimeFloor } = require('../../src/shared/usage/clientUsageArchive');
  const fixture = setup(t);
  const input = record(extractUsageFromTokscale(report(['gpt-5.5'], 'Current Label', 120)));
  input.allTime.sessions['opencode:one'].modelCosts['cost-only label'] = 0;
  fixture.store.capture(input, AT);
  const stale = record(extractUsageFromTokscale(report(['older-id'], 'Older Label', 100)));
  fixture.store.capture(stale, new Date(AT.getTime() - 1000));
  const archived = fixture.store.read(AT);
  assert.deepEqual(archived.sessions['opencode:one'].observedModels,
    ['cost-only label', 'current label', 'gpt-5.5', 'older label', 'older-id']);
  assert.equal(archived.sessions['opencode:one'].periods.allTime.totalTokens, 120);
  const retained = structuredClone(archived);
  delete retained.sessions['opencode:one'].observedModels;
  const normalized = normalizeSessionUsageArchive(retained);
  assert.deepEqual(normalized.sessions['opencode:one'].observedModels, ['cost-only label', 'current label', 'gpt-5.5']);
  const floor = { opencode: { models: { 'current label': 100, 'gpt-5.5': 100 }, modelCosts: { 'cost-only label': 1 } } };
  const excluded = applyDailyHistoryAllTimeFloor(record(normalizePeriod({})), floor, { sessionArchive: retained });
  assert.equal(excluded.allTime.totalTokens, 0);
  assert.equal(excluded.allTime.costUsd, 0);
  fixture.reopen();
  assert.deepEqual(fixture.store.read(AT).sessions['opencode:one'].observedModels, archived.sessions['opencode:one'].observedModels);
});

test('same-amount display metadata changes persist alongside the canonical identity', t => {
  const fixture = setup(t);
  fixture.store.capture(record(extractUsageFromTokscale(report(['gpt-5.5'], 'Old Label'))), AT);
  const capture = fixture.store.capture(record(extractUsageFromTokscale(report())), new Date(AT.getTime() + 1000));
  assert.equal(capture.changedKeys.has('opencode:one'), true);
  fixture.reopen();
  assert.deepEqual(fixture.store.read(AT).sessions['opencode:one'].observedModels, ['gpt 5.5', 'gpt-5.5', 'old label']);
  assert.equal(fixture.transform().transform(record(normalizePeriod({}))).allTime.totalTokens, 100);
});

for (const provenance of ['usageSource', 'ledger']) {
  test(`native live session coverage excludes Dots identities marked by ${provenance}`, () => {
    const { applyDailyHistoryAllTimeFloor } = require('../../src/shared/usage/clientUsageArchive');
    const json = { entries: [
      { client: 'codex', sessionId: 'native', model: 'Native Label', canonicalModelIds: ['native-id'], input: 20, cost: 0.2 },
      { client: 'codex', sessionId: 'dots', model: 'Dots Label', canonicalModelIds: ['daily-native-id'], input: 50, cost: 0.5 }
    ] };
    const input = record(extractUsageFromTokscale(json));
    if (provenance === 'usageSource') input.allTime.sessions['codex:dots'].usageSource = 'codex-dots-local';
    else input.codexLocalSessionKeys = ['codex:dots'];
    const visible = applyDailyHistoryAllTimeFloor(input, { codex: { models: { 'daily-native-id': 100 }, modelCosts: { 'daily-native-id': 1 } } });
    assert.equal(visible.allTime.totalTokens, 170);
    assert.equal(visible.allTime.costUsd, 1.7);
  });
}

for (const sourceStillPresent of [true, false]) {
  test(`legacy label-only coverage can gain IDs only when source remains (${sourceStillPresent})`, t => {
    const fixture = setup(t);
    const old = report(); delete old.entries[0].canonicalModelIds;
    const legacy = record(extractUsageFromTokscale(old));
    assert.equal(fixture.transform().transform(legacy).allTime.totalTokens, 200);
    assert.equal(fixture.store.read(AT).sessions['opencode:one'].periods.allTime.totalTokens, 100);
    const transform = fixture.reopen();
    const next = sourceStillPresent ? record(extractUsageFromTokscale(report())) : record(normalizePeriod({}));
    assert.equal(transform.transform(next).allTime.totalTokens, sourceStillPresent ? 100 : 200);
  });
}

test('canonical recovery evidence remains local and does not enter the sync payload', () => {
  const { serializeSyncPayload } = require('../../src/shared/syncPayload');
  const input = record(extractUsageFromTokscale(report()));
  const payload = serializeSyncPayload(input).payload;
  assert.equal(payload.today.clientModelIds, undefined);
  assert.equal(payload.month.clientModelIds, undefined);
  assert.equal(payload.month.sessions['opencode:one'].canonicalModelIds, undefined);
  assert.deepEqual(input.allTime.clientModelIds.opencode, ['gpt-5.5']);
  assert.deepEqual(input.allTime.sessions['opencode:one'].canonicalModelIds, ['gpt-5.5']);
});

test('collector full and one-scan watch preserve metadata-only canonical coverage changes', async t => {
  const { collectUsageOnce, localTodayKey } = require('../../src/shared/collector');
  const fixture = setup(t, [['model-a', 100], ['model-b', 100]]);
  let anchor, ids = ['model-a'];
  const calls = [];
  const options = { clients: 'opencode', allTimeSince: '2024-01-01', deviceId: 'fixture', now: AT,
    homeDir: fixture.dir, env: {}, osInfo: {}, projectsEnabled: false, wslScanEnabled: false,
    codexLocalUsageEnabled: false, historyEnabled: false,
    sessionMetadataDeps: { sessionMetadataResolvers: new Map() }, lookupModelPricing: async () => null,
    onAnchorComputed: value => { anchor = value; },
    runTokscale: async ({ flags }) => { calls.push(flags); return report(ids); } };
  const transform = fixture.transform();
  assert.equal(transform.transform(await collectUsageOnce(options)).allTime.totalTokens, 200,
    'the genuinely missing model-b is still eligible before it is observed');
  assert.equal(calls.length, 3);
  ids = ['model-a', 'model-b']; calls.length = 0;
  const watch = await collectUsageOnce({ ...options, now: new Date(AT.getTime() + 1000),
    todayOnlyAnchor: { ...anchor.windowsPeriods, dateKey: localTodayKey(AT), todayPartitions: anchor.todayPartitions } });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('--today'));
  assert.equal(watch.allTime.totalTokens, 100);
  assert.deepEqual(watch.allTime.sessions['opencode:one'].canonicalModelIds, ['model-a', 'model-b']);
  assert.equal(transform.transform(watch).allTime.totalTokens, 100);
  assert.deepEqual(fixture.store.read(AT).sessions['opencode:one'].observedModels, ['gpt 5.5', 'model-a', 'model-b']);
  assert.equal(fixture.reopen().transform(record(normalizePeriod({}))).allTime.totalTokens, 100);
});

for (const olderGraph of [false, true]) {
  test(`history-on collector full/watch exclude retained display usage (older graph: ${olderGraph})`, async t => {
    const { collectUsageOnce, localTodayKey } = require('../../src/shared/collector');
    const { readDailyHistoryArchive } = require('../../src/shared/dailyHistoryArchive');
    const fixture = setup(t, []);
    fs.unlinkSync(fixture.dailyPath);
    const day = localTodayKey(AT);
    const graph = { contributions: olderGraph ? [{ date: day, clients: [{ client: 'opencode',
      modelId: 'gpt-5.5', tokens: { input: 100 }, cost: 1 }] }] : [] };
    let anchor, tokens = 120;
    const calls = [];
    const options = { clients: 'opencode', allTimeSince: '2024-01-01', deviceId: 'fixture', now: AT,
      homeDir: fixture.dir, env: {}, osInfo: {}, projectsEnabled: false, wslScanEnabled: false,
      codexLocalUsageEnabled: false, historyEnabled: true, dailyHistoryArchiveEnabled: true,
      dailyHistoryArchiveOptions: { path: fixture.dailyPath },
      sessionMetadataDeps: { sessionMetadataResolvers: new Map() }, lookupModelPricing: async () => null,
      onAnchorComputed: value => { anchor = value; },
      runTokscale: async ({ flags }) => { calls.push(flags); return report(['gpt-5.5'], 'GPT 5.5', tokens); },
      runGraph: async () => { calls.push('graph'); return graph; } };
    let transform = fixture.transform();
    const full = await collectUsageOnce({ ...options, includeHistory: true });
    assert.equal(calls.length, 4, 'three report scans and one requested graph scan');
    assert.equal(full.history.daily.find(row => row.date === day).tokens, 120);
    assert.equal(Object.values(readDailyHistoryArchive({ path: fixture.dailyPath }).liveDays[day].observations)[0].modelId, 'gpt 5.5');
    const visible = transform.transform(full);
    assert.equal(visible.allTime.totalTokens, 120);
    assert.equal(visible.allTime.costUsd, 1.2);
    assert.deepEqual(visible.allTime.models, { 'gpt 5.5': 120 });
    for (tokens of [120, 20]) {
      const previous = anchor;
      calls.length = 0;
      const watch = await collectUsageOnce({ ...options, now: new Date(AT.getTime() + 1000),
        todayOnlyAnchor: { ...previous.windowsPeriods, dateKey: day, todayPartitions: previous.todayPartitions } });
      assert.equal(calls.length, 1);
      assert.ok(calls[0].includes('--today'));
      assert.equal(transform.transform(watch).allTime.totalTokens, tokens);
    }
    assert.deepEqual(fixture.store.read(AT).sessions['opencode:one'].observedModels, ['gpt 5.5', 'gpt-5.5']);
    transform = fixture.reopen();
    assert.equal(transform.transform(record(normalizePeriod({}))).allTime.totalTokens, 20);
    assert.ok(Math.abs(transform.transform(record(normalizePeriod({}))).allTime.costUsd - 0.2) < 1e-12);
  });
}

test('paused retention keeps canonical evidence across local untrack, settings save and SQLite reopen', t => {
  const { createDeviceState } = require('../../src/shared/usage/deviceState');
  const { selectLocalDeviceRecord } = require('../../src/electron/diagnosticSnapshot');
  const { captureArchivedClientUsage, normalizeArchivedClientUsage } = require('../../src/shared/usage/clientUsageArchive');
  const fixture = setup(t);
  const old = report(); delete old.entries[0].canonicalModelIds;
  fixture.store.capture(record(extractUsageFromTokscale(old)), AT);
  let settings = { clients: 'opencode', projectsEnabled: false, allTimeSince: '2024-01-01' };
  const transform = () => createUsageTransform({ store: fixture.store, dailyHistoryArchive: { path: fixture.dailyPath },
    getSettings: () => settings, log() {} });
  assert.equal(transform().transform(record(extractUsageFromTokscale(old))).allTime.totalTokens, 200);
  settings.sessionUsageArchiveEnabled = false;
  const state = createDeviceState();
  const paused = transform().transform({ ...record(extractUsageFromTokscale(report())), deviceId: 'fixture' });
  assert.equal(paused.allTime.totalTokens, 100);
  state.updateUsage(paused);
  const local = selectLocalDeviceRecord({ deviceId: 'fixture', lastCollectedDevice: state.getSnapshot() });
  settings.archivedClientUsage = captureArchivedClientUsage({}, local, ['opencode'], AT);
  settings.clients = '';
  settings = JSON.parse(JSON.stringify(settings));
  settings.archivedClientUsage = normalizeArchivedClientUsage(settings.archivedClientUsage);
  const frozen = settings.archivedClientUsage.clients.opencode.periods.allTime;
  assert.equal(frozen.clientModelIds, undefined);
  assert.deepEqual(frozen.sessions['opencode:one'].canonicalModelIds, ['gpt-5.5']);
  assert.deepEqual(fixture.store.read(AT).sessions['opencode:one'].observedModels, ['gpt 5.5']);
  settings.sessionUsageArchiveEnabled = true;
  fixture.reopen();
  const resumed = transform().transform(record(normalizePeriod({})));
  assert.equal(resumed.allTime.totalTokens, 100);
  assert.equal(resumed.allTime.costUsd, 1);
  assert.deepEqual(resumed.allTime.sessions['opencode:one'].canonicalModelIds, ['gpt-5.5']);
  fixture.reopen();
  assert.equal(transform().transform(record(normalizePeriod({}))).allTime.totalTokens, 100);
});

test('a legacy inflated frozen client stays unchanged until a tracked paired full scan supplies IDs', t => {
  const { captureArchivedClientUsage, normalizeArchivedClientUsage, pruneArchivedClientUsage } = require('../../src/shared/usage/clientUsageArchive');
  const fixture = setup(t);
  const old = report(); delete old.entries[0].canonicalModelIds;
  const before = fixture.transform().transform(record(extractUsageFromTokscale(old)));
  assert.equal(before.allTime.totalTokens, 200);
  assert.equal(fixture.store.read(AT).sessions['opencode:one'].periods.allTime.totalTokens, 100);
  let settings = JSON.parse(JSON.stringify({ clients: '', projectsEnabled: false,
    allTimeSince: '2024-01-01', archivedClientUsage: captureArchivedClientUsage({}, before, ['opencode'], AT) }));
  settings.archivedClientUsage = normalizeArchivedClientUsage(settings.archivedClientUsage);
  const transform = () => createUsageTransform({ store: fixture.store, dailyHistoryArchive: { path: fixture.dailyPath },
    getSettings: () => settings, log() {} });
  fixture.reopen();
  assert.equal(transform().transform(record(normalizePeriod({}))).allTime.totalTokens, 200);
  settings.clients = 'opencode';
  settings.archivedClientUsage = pruneArchivedClientUsage(settings.archivedClientUsage, settings.clients);
  assert.deepEqual(settings.archivedClientUsage.clients, {});
  assert.equal(transform().transform(record(extractUsageFromTokscale(report()))).allTime.totalTokens, 100);
  fixture.reopen();
  assert.equal(transform().transform(record(normalizePeriod({}))).allTime.totalTokens, 100);
});

test('headless normal and dry-run projections consume canonical coverage', t => {
  const vm = require('node:vm');
  const { sessionUsageArchiveDate, updateSessionUsageArchive, applySessionUsageArchive } = require('../../src/shared/usage/sessionUsageArchive');
  const { applyDailyHistoryAllTimeFloor } = require('../../src/shared/usage/clientUsageArchive');
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/agent/agent.js'), 'utf8');
  const start = source.indexOf('function summaryWithSessionUsageArchive(');
  const body = source.slice(start, source.indexOf('\n}\n', start) + 3);
  for (const dryRun of [false, true]) {
    const fixture = setup(t);
    const context = { allTimeSince: '2024-01-01', sessionUsageArchiveEnabled: true, dryRun, projectsEnabled: false,
      sessionUsageArchive: undefined, cursorUsageEvents: undefined,
      sessionUsageArchiveStore: fixture.store, sessionUsageArchiveDate, updateSessionUsageArchive, applySessionUsageArchive,
      applyDailyHistoryAllTimeFloor, readSessionUsageArchiveSnapshot: () => ({ version: 1, sessions: {} }),
      loadDailyHistoryFloor: () => ({ opencode: { models: { 'gpt-5.5': 100 }, modelCosts: { 'gpt-5.5': 1 } } }) };
    vm.runInNewContext(body, context);
    const visible = context.summaryWithSessionUsageArchive(record(extractUsageFromTokscale(report())), AT);
    assert.equal(visible.allTime.totalTokens, 100);
    assert.equal(visible.allTime.costUsd, 1);
    assert.deepEqual(Object.keys(visible.allTime.models), ['gpt 5.5']);
  }
});

test('real usage worker preserves canonical coverage through IPC and SQLite', async t => {
  const { Worker } = require('node:worker_threads');
  const { createUsageHostCoordinator } = require('../../src/shared/usage/usageHost');
  const { readSessionUsageArchiveSnapshot } = require('../../src/shared/usage/sessionUsageArchiveStore');
  const fixture = setup(t);
  fs.copyFileSync(fixture.dailyPath, path.join(fixture.dir, 'daily-history-archive.json'));
  class IsolatedWorker extends Worker {
    constructor(file, options) {
      super(file, { ...options, env: { HOME: fixture.dir, TOKEN_MONITOR_SHARED_DIR: fixture.dir } });
    }
  }
  const keepAlive = setInterval(() => {}, 1000);
  const records = [];
  const coordinator = createUsageHostCoordinator({ Worker: IsolatedWorker,
    workerPath: path.resolve(__dirname, '../fixtures/usageWorkerScriptedCollector.js') });
  const runtime = coordinator.create({ clients: 'opencode',
    scriptedSummary: record(extractUsageFromTokscale(report())), onUpdate: summary => records.push(summary)
  }, { transformSettings: { clients: 'opencode', projectsEnabled: false, allTimeSince: '2024-01-01' } });
  try {
    await runtime.tick('startup');
    assert.equal(records.length, 1);
    assert.equal(records[0].allTime.totalTokens, 100);
    assert.equal(records[0].allTime.costUsd, 1);
  } finally {
    runtime.stop(); await runtime.whenIdle(); clearInterval(keepAlive);
  }
  const archived = readSessionUsageArchiveSnapshot({
    databasePath: path.join(fixture.dir, 'session-usage-archive.sqlite'), strict: true
  });
  assert.deepEqual(archived.sessions['opencode:one'].observedModels, ['gpt 5.5', 'gpt-5.5']);
});
