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
  assert.deepEqual(entry.observedModels, ['model-a', 'model-b']);
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
  for (const tokens of [100, 20, 0]) {
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
  assert.deepEqual(values, [100, 20, 0, 0]);
});

test('canonical model coverage works without a session identity', t => {
  const fixture = setup(t);
  const json = report(); delete json.entries[0].sessionId;
  const visible = fixture.transform().transform(record(extractUsageFromTokscale(json)));
  assert.equal(visible.allTime.totalTokens, 100);
  assert.equal(visible.allTime.costUsd, 1);
});

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
  assert.deepEqual(fixture.store.read(AT).sessions['opencode:one'].observedModels, ['model-a', 'model-b']);
  assert.equal(fixture.reopen().transform(record(normalizePeriod({}))).allTime.totalTokens, 100);
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
  assert.deepEqual(archived.sessions['opencode:one'].observedModels, ['gpt-5.5']);
});
