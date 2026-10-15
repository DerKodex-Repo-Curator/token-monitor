'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { collectUsageOnce, startCollector, localTodayKey, collectorAnchorTrust, configFingerprint } = require('../../src/shared/collector');
const { applySessionUsageArchive, updateSessionUsageArchive } = require('../../src/shared/usage/sessionUsageArchive');
const { normalizeClientName } = require('../../src/shared/usage');

function contribution(date, tokens, model = 'opus', cost = tokens / 100, client = 'claude') {
  return { date, clients: [{ client, modelId: model, tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 }, cost, messages: 1 }] };
}

function sourceGraph(now, sessions, extra = {}) {
  const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
  const selected = extra.replacementClients || ['claude'];
  const rawClients = [...new Set([...selected, ...sessions.map(row => row.client)])];
  const replacementClients = rawClients.filter(client => selected.includes(client)
    || selected.some(value => normalizeClientName(value) === normalizeClientName(client)));
  return { contributions: sessions.flatMap(row => row.days), sourceUsage: {
    version: 2, eventIdentityVersion: 2, fullHistory: true, capturedAt: now.toISOString(), bucketTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    dayKey: localTodayKey(now), ...extra, replacementClients,
    scopes: rawClients.map(client => ({ id: digest(`domain:${client}`), clients: [client],
      readStatus: extra.partialClients?.includes(client) ? 'partial' : 'complete', identityStatus: 'exact' })),
    sessions: sessions.map(row => ({ client: row.client, sessionId: row.sessionId, scopeId: digest(`domain:${row.client}`),
      events: row.days.map((day, index) => ({ id: digest(`${row.client}:${row.sessionId}:${day.date}:${index}`),
        contributions: day.clients.map(value => {
          const [year, month, date] = day.date.split('-').map(Number);
          return { timestamp: new Date(year, month - 1, date, 12).getTime(), modelId: value.modelId,
            providerId: value.providerId || '', cost: value.cost, messages: value.messages,
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, ...value.tokens } };
        }) })) }))
  } };
}

function optionsFor(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-source-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { clients: 'claude', allTimeSince: '2026-01-01', deviceId: 'source-fixture',
    homeDir: dir, env: {}, osInfo: {}, wslScanEnabled: false, projectsEnabled: false,
    codexLocalUsageEnabled: false, includeHistory: true, dailyHistoryArchiveEnabled: true,
    getSessionUsageArchive: () => ({ version: 1, sessions: {} }),
    dailyHistoryArchiveOptions: { path: path.join(dir, 'daily.json') },
    sessionMetadataDeps: { resolveSessionMetadata: () => null } };
}

test('collector projects one graph snapshot into totals, history and subsequent watch anchor', async t => {
  const options = optionsFor(t);
  const now = new Date(2026, 9, 11, 12);
  const today = localTodayKey(now);
  const yesterday = localTodayKey(new Date(2026, 9, 10, 12));
  let anchor;
  const summary = await collectUsageOnce({ ...options, now,
    runTokscale: async () => ({ entries: [{ client: 'claude', sessionId: 'a', model: 'opus', provider: 'anthropic', input: 900, cost: 9 }] }),
    runGraph: async () => sourceGraph(now, [{ client: 'claude', sessionId: 'a', days: [contribution(yesterday, 20, 'sonnet', 0)] }]),
    onAnchorComputed: value => { anchor = value; }
  });
  assert.equal(summary.today.totalTokens, 0);
  assert.equal(summary.month.totalTokens, 20);
  assert.equal(summary.allTime.totalTokens, 20);
  assert.equal(summary.allTime.costUsd, 0);
  assert.deepEqual(summary.allTime.models, { sonnet: 20 });
  assert.equal(summary.history.summary.totalTokens, 20);
  assert.equal(anchor.windowsPeriods.today.totalTokens, 0);
  assert.equal(anchor.windowsPeriods.allTime.totalTokens, 20);
  const watch = await collectUsageOnce({ ...options, now, includeHistory: false,
    todayOnlyAnchor: { ...anchor.windowsPeriods, dateKey: today, todayPartitions: anchor.todayPartitions },
    runTokscale: async () => ({ entries: [{ client: 'claude', sessionId: 'a', model: 'sonnet', provider: 'anthropic', input: 5, cost: 0 }] })
  });
  assert.equal(watch.today.totalTokens, 5);
  assert.equal(watch.allTime.totalTokens, 25);
});

test('source snapshot serialization restores omitted IDs exactly once through session archive transform', async t => {
  const options = optionsFor(t);
  const now = new Date(2026, 9, 11, 12);
  const date = localTodayKey(now);
  const first = await collectUsageOnce({ ...options, now,
    runTokscale: async () => ({ entries: [{ client: 'claude', sessionId: 'a', model: 'opus', provider: 'anthropic', input: 100, cost: 1 }] }),
    runGraph: async () => sourceGraph(now, [{ client: 'claude', sessionId: 'a', days: [contribution(date, 100)] }])
  });
  const archive = updateSessionUsageArchive({}, first, now).archive;
  let anchor;
  const next = await collectUsageOnce({ ...options, now: new Date(now.getTime() + 60000),
    runTokscale: async () => ({ entries: [] }),
    runGraph: async () => sourceGraph(new Date(now.getTime() + 60000), []),
    onAnchorComputed: value => { anchor = value; }
  });
  assert.equal(next.allTime.totalTokens, 100);
  assert.equal(next.history.summary.totalTokens, 100);
  const projected = applySessionUsageArchive(next, archive, { now });
  assert.equal(projected.allTime.totalTokens, 100);
  assert.equal(projected.allTime.sessions['claude:a'].sourceState, 'unknown');
  assert.equal(projected.allTime.sessions['claude:a'].archived, undefined);
  assert.equal(anchor.windowsPeriods.allTime.totalTokens, 0);
  const watch = await collectUsageOnce({ ...options, now, includeHistory: false,
    todayOnlyAnchor: { ...anchor.windowsPeriods, dateKey: date, todayPartitions: anchor.todayPartitions },
    runTokscale: async () => ({ entries: [] }) });
  assert.equal(watch.today.totalTokens, 100);
  assert.equal(watch.allTime.totalTokens, 100);
});

test('disabled clients cannot replay a persisted source archive', async t => {
  const options = optionsFor(t);
  const now = new Date(2026, 9, 11, 12);
  await collectUsageOnce({ ...options, now, runTokscale: async () => ({ entries: [] }),
    runGraph: async () => sourceGraph(now, [{ client: 'claude', sessionId: 'a', days: [contribution(localTodayKey(now), 100)] }]) });
  const next = await collectUsageOnce({ ...options, clients: 'codex', now, includeHistory: false,
    runTokscale: async () => ({ entries: [] }) });
  assert.equal(next.allTime.totalTokens, 0);
  assert.deepEqual(next.sessionArchiveSource.managedKeys, []);
});

test('source projection preserves matching native throughput across multiple sessions', async t => {
  const options = optionsFor(t);
  const now = new Date(2026, 9, 11, 12);
  const days = [contribution(localTodayKey(now), 100)];
  days[0].clients[0].tokens = { input: 80, output: 20, cacheRead: 0, cacheWrite: 0 };
  days[0].clients[0].providerId = 'anthropic';
  let anchor;
  const summary = await collectUsageOnce({ ...options, now,
    runTokscale: async () => ({ entries: ['a', 'b'].map(sessionId => ({ client: 'claude', sessionId,
      model: 'opus', provider: 'anthropic', input: 80, output: 20, cost: 1,
      performance: { timedTokens: 100, totalDurationMs: 1000 } })) }),
    runGraph: async () => sourceGraph(now, ['a', 'b'].map(sessionId => ({ client: 'claude', sessionId, days }))),
    onAnchorComputed: value => { anchor = value; }
  });
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(summary[name].timedDurationMs, 2000);
    assert.equal(summary[name].timedOutputTokens, 40);
    assert.equal(summary[name].timedTokens, 200);
    assert.equal(summary[name].modelThroughput.opus.timedDurationMs, 2000);
    assert.equal(summary[name].sessions['claude:a'].timedDurationMs, 1000);
    assert.deepEqual(summary[name].sessions['claude:a'].providers, { anthropic: 100 });
    assert.equal(anchor.windowsPeriods[name].timedDurationMs, 2000);
  }
});

test('a changed host timezone invalidates the persisted today delta anchor', t => {
  const prior = process.env.TZ;
  t.after(() => { if (prior === undefined) delete process.env.TZ; else process.env.TZ = prior; });
  const now = new Date('2026-10-11T04:00:00Z');
  process.env.TZ = 'Asia/Hong_Kong';
  const period = { totalTokens: 10, sessions: {} };
  const saved = { dateKey: localTodayKey(now), today: period, month: period, allTime: period,
    configFingerprint: configFingerprint('claude', '2026-01-01'), fullScanAt: now.toISOString() };
  assert.ok(collectorAnchorTrust(saved, { now, clients: 'claude', allTimeSince: '2026-01-01' }));
  process.env.TZ = 'Asia/Tokyo';
  assert.equal(localTodayKey(now), saved.dateKey);
  assert.equal(collectorAnchorTrust(saved, { now, clients: 'claude', allTimeSince: '2026-01-01' }), null);
});

function nativeRow(sessionId, input, client = 'claude') {
  return { client, sessionId, model: 'opus', provider: 'anthropic', input, cost: input / 100 };
}

function anchorFrom(captured, now) {
  return { ...captured.windowsPeriods, dateKey: localTodayKey(now), todayPartitions: captured.todayPartitions,
    nativeRawPresence: captured.nativeRawPresence };
}

for (const failure of ['throw', 'no-source', 'stale']) {
  for (const knownHealthy of [true, false]) test(`${failure} graph preserves accepted accounting; healthy snapshot=${knownHealthy}`, async t => {
    const options = optionsFor(t);
    const now = new Date(2026, 9, 11, 12);
    const date = localTodayKey(now);
    let previous;
    await collectUsageOnce({ ...options, now,
      runTokscale: async () => ({ entries: [nativeRow('a', 100), nativeRow('gone', 20)] }),
      runGraph: async () => sourceGraph(now, ['a', 'gone'].map(sessionId => ({ client: 'claude', sessionId,
        days: [contribution(date, sessionId === 'a' ? 100 : 20)] }))),
      onSourceArchiveComputed: value => { previous = value; } });
    const later = new Date(now.getTime() + 60000);
    let captured;
    let cached;
    const rows = [nativeRow('a', 400), nativeRow('b', 50)];
    const summary = await collectUsageOnce({ ...options, now: later, sourceArchiveSnapshot: knownHealthy ? previous : undefined,
      runTokscale: async () => ({ entries: rows }),
      runGraph: async () => {
        if (failure === 'throw') throw new Error('graph timeout');
        if (failure === 'no-source') return { contributions: [] };
        return sourceGraph(new Date(now.getTime() - 60000), [{ client: 'claude', sessionId: 'a', days: [contribution(date, 5)] }]);
      },
      onAnchorComputed: value => { captured = value; },
      onSourceArchiveComputed: value => { cached = value; }
    });
    const locked = failure === 'throw' && !knownHealthy;
    assert.equal(cached.scopes[0].blockNativeWatch === true, locked);
    for (const name of ['today', 'month', 'allTime']) {
      assert.equal(summary[name].totalTokens, 120);
      assert.equal(summary[name].sessions['claude:a'].totalTokens, 100);
      assert.equal(summary[name].sessions['claude:b'], undefined);
      assert.equal(summary[name].sessions['claude:gone'].sourceState, 'unknown');
      assert.equal(summary[name].sessions['claude:gone'].retained, true);
      assert.equal(summary[name].sessions['claude:gone'].archived, undefined);
      assert.equal(captured.windowsPeriods[name].totalTokens, 100);
    }
    for (let i = 0; i < 2; i++) {
      const watch = await collectUsageOnce({ ...options, now: later, includeHistory: false,
        sourceArchiveSnapshot: cached, todayOnlyAnchor: anchorFrom(captured, later),
        runTokscale: async () => ({ entries: [nativeRow('a', 410), nativeRow('b', 50)] }) });
      assert.equal(watch.today.totalTokens, locked ? 120 : 480);
      assert.equal(watch.allTime.totalTokens, locked ? 120 : 480);
    }
    const recoveredAt = new Date(later.getTime() + 1000);
    const recovered = await collectUsageOnce({ ...options, now: recoveredAt, sourceArchiveSnapshot: cached,
      runTokscale: async () => ({ entries: [nativeRow('a', 410), nativeRow('b', 50)] }),
      runGraph: async () => sourceGraph(recoveredAt, [
        { client: 'claude', sessionId: 'a', days: [contribution(date, 410)] },
        { client: 'claude', sessionId: 'b', days: [contribution(date, 50)] }
      ]), onAnchorComputed: value => { captured = value; }, onSourceArchiveComputed: value => { cached = value; } });
    assert.equal(recovered.allTime.totalTokens, 480);
    assert.notEqual(cached.scopes[0].blockNativeWatch, true);
    const growing = await collectUsageOnce({ ...options, now: recoveredAt, includeHistory: false,
      sourceArchiveSnapshot: cached, todayOnlyAnchor: anchorFrom(captured, recoveredAt),
      runTokscale: async () => ({ entries: [nativeRow('a', 420), nativeRow('b', 50)] }) });
    assert.equal(growing.allTime.totalTokens, 490);
  });
}

test('fresh source replacement is scoped to the clients accepted from this graph scan', async t => {
  const options = { ...optionsFor(t), clients: 'claude,codex' };
  const now = new Date(2026, 9, 11, 12);
  const date = localTodayKey(now);
  await collectUsageOnce({ ...options, now, runTokscale: async () => ({ entries: [] }),
    runGraph: async () => sourceGraph(now, [{ client: 'codex', sessionId: 'x', days: [contribution(date, 70, 'opus', 0.7, 'codex')] }],
      { replacementClients: ['codex'] }) });
  const later = new Date(now.getTime() + 60000);
  let captured;
  const summary = await collectUsageOnce({ ...options, now: later,
    runTokscale: async () => ({ entries: [nativeRow('a', 900), nativeRow('x', 700, 'codex'), nativeRow('new', 30, 'codex')] }),
    runGraph: async () => sourceGraph(later, [{ client: 'claude', sessionId: 'a', days: [contribution(date, 10)] }]),
    onAnchorComputed: value => { captured = value; } });
  assert.equal(summary.allTime.totalTokens, 80);
  assert.equal(summary.allTime.sessions['codex:x'].totalTokens, 70);
  assert.equal(summary.allTime.sessions['codex:new'], undefined);
  assert.equal(captured.windowsPeriods.allTime.totalTokens, 80);
});

test('an absent source reappearing on watch adds only past days missing from each native anchor', async t => {
  const options = optionsFor(t);
  const now = new Date(2026, 9, 11, 12);
  const today = localTodayKey(now);
  const yesterday = localTodayKey(new Date(2026, 9, 10, 12));
  await collectUsageOnce({ ...options, now,
    runTokscale: async ({ flags }) => ({ entries: [nativeRow('a', flags.includes('--today') ? 20 : 120)] }),
    runGraph: async () => sourceGraph(now, [{ client: 'claude', sessionId: 'a', days: [contribution(yesterday, 100), contribution(today, 20)] }]) });
  const later = new Date(now.getTime() + 60000);
  let captured;
  let cached;
  const absent = await collectUsageOnce({ ...options, now: later, runTokscale: async () => ({ entries: [] }),
    runGraph: async () => sourceGraph(later, []), onAnchorComputed: value => { captured = value; },
    onSourceArchiveComputed: value => { cached = value; } });
  assert.equal(absent.allTime.totalTokens, 120);
  assert.equal(captured.windowsPeriods.allTime.totalTokens, 0);
  for (const tokens of [20, 25, 25]) {
    let calls = 0;
    const watch = await collectUsageOnce({ ...options, now: later, includeHistory: false, sourceArchiveSnapshot: cached,
      todayOnlyAnchor: anchorFrom(captured, later), runTokscale: async ({ flags }) => {
        calls++;
        assert.deepEqual(flags, ['--today']);
        return { entries: [nativeRow('a', tokens)] };
      } });
    assert.equal(calls, 1);
    assert.equal(watch.today.totalTokens, tokens);
    assert.equal(watch.month.totalTokens, 100 + tokens);
    assert.equal(watch.allTime.totalTokens, 100 + tokens);
    assert.equal(watch.allTime.sessions['claude:a'].retained, undefined);
  }
});

test('period presence is independent when allTimeSince excludes a live month session', async t => {
  const options = { ...optionsFor(t), allTimeSince: '2026-10-08' };
  const now = new Date(2026, 9, 11, 12);
  let captured;
  let cached;
  const full = await collectUsageOnce({ ...options, now,
    runTokscale: async ({ flags }) => ({ entries: flags.includes('--month') ? [nativeRow('a', 100)] : [] }),
    runGraph: async () => sourceGraph(now, [{ client: 'claude', sessionId: 'a', days: [contribution('2026-10-03', 100)] }]),
    onAnchorComputed: value => { captured = value; }, onSourceArchiveComputed: value => { cached = value; } });
  assert.equal(full.month.totalTokens, 100);
  assert.equal(full.allTime.totalTokens, 0);
  const watch = await collectUsageOnce({ ...options, now, includeHistory: false, sourceArchiveSnapshot: cached,
    todayOnlyAnchor: anchorFrom(captured, now), runTokscale: async () => ({ entries: [] }) });
  assert.equal(watch.today.totalTokens, 0);
  assert.equal(watch.month.totalTokens, 100);
  assert.equal(watch.allTime.totalTokens, 0);
});

test('source replay cannot undo a watch correction that removes the last native Today row', async t => {
  const options = optionsFor(t);
  const now = new Date(2026, 9, 11, 12);
  let captured;
  let cached;
  await collectUsageOnce({ ...options, now, runTokscale: async () => ({ entries: [nativeRow('a', 100)] }),
    runGraph: async () => sourceGraph(now, [{ client: 'claude', sessionId: 'a', days: [contribution(localTodayKey(now), 100)] }]),
    onAnchorComputed: value => { captured = value; }, onSourceArchiveComputed: value => { cached = value; } });
  const watch = await collectUsageOnce({ ...options, now, includeHistory: false, sourceArchiveSnapshot: cached,
    todayOnlyAnchor: anchorFrom(captured, now), runTokscale: async () => ({ entries: [] }) });
  for (const name of ['today', 'month', 'allTime']) assert.equal(watch[name].totalTokens, 0);
});

test('canonical source aliases share native presence and watch accounting keys', async t => {
  const options = { ...optionsFor(t), clients: 'claude,kimi' };
  const now = new Date(2026, 9, 11, 12);
  let captured;
  let cached;
  const rows = [nativeRow('m', 100, 'cc-mirror/kimi-code')];
  const full = await collectUsageOnce({ ...options, now, runTokscale: async () => ({ entries: rows }),
    runGraph: async () => sourceGraph(now, [{ client: 'cc-mirror/kimi-code', sessionId: 'm',
      days: [contribution(localTodayKey(now), 100, 'opus', 1, 'cc-mirror/kimi-code')] }], { replacementClients: ['claude', 'kimi'] }),
    onAnchorComputed: value => { captured = value; }, onSourceArchiveComputed: value => { cached = value; } });
  assert.equal(full.allTime.totalTokens, 100);
  assert.deepEqual(full.sessionArchiveSource.managedKeys, ['kimi:m']);
  const watch = await collectUsageOnce({ ...options, now, includeHistory: false, sourceArchiveSnapshot: cached,
    todayOnlyAnchor: anchorFrom(captured, now), runTokscale: async () => ({ entries: rows }) });
  assert.equal(watch.allTime.totalTokens, 100);
  assert.deepEqual(Object.keys(watch.allTime.sessions), ['kimi:m']);
});

test('source replacement preserves complete metadata on untouched native periods and anchors', async t => {
  const now = new Date(2026, 9, 11, 12);
  const metadata = { title: 'Codex title', startedAt: new Date(now.getTime() - 60000).toISOString(), lastUsedAt: now.toISOString(),
    contextTokens: 123, contextWindow: 1000, turnEnded: true, waitingForInput: true,
    promptCache: { ttlSeconds: 300, observedAt: now.toISOString() } };
  const options = { ...optionsFor(t), clients: 'claude,codex', sessionMetadataDeps: {
    sessionMetadataResolvers: new Map([['codex', { resolve: ids => new Map([...ids].map(id => [id, metadata])) }]])
  } };
  const runTokscale = async ({ flags }) => ({ entries: [nativeRow('a', 100),
    ...(!flags.includes('--today') ? [nativeRow('old', 70, 'codex')] : [])] });
  const baseline = await collectUsageOnce({ ...options, now, includeHistory: false, dailyHistoryArchiveEnabled: false, runTokscale });
  let captured;
  const full = await collectUsageOnce({ ...options, now, runTokscale,
    runGraph: async () => sourceGraph(now, [{ client: 'claude', sessionId: 'a', days: [contribution(localTodayKey(now), 100)] }]),
    onAnchorComputed: value => { captured = value; } });
  for (const name of ['month', 'allTime']) {
    assert.equal(baseline[name].sessions['codex:old'].contextTokens, 123);
    assert.equal(baseline[name].sessions['codex:old'].waitingForInput, true);
    assert.deepEqual(baseline[name].sessions['codex:old'].promptCache, metadata.promptCache);
    assert.deepEqual(full[name].sessions['codex:old'], baseline[name].sessions['codex:old']);
    assert.deepEqual(captured.windowsPeriods[name].sessions['codex:old'], baseline[name].sessions['codex:old']);
  }
  const watch = await collectUsageOnce({ ...options, now, includeHistory: false,
    todayOnlyAnchor: anchorFrom(captured, now), runTokscale });
  assert.deepEqual(watch.allTime.sessions['codex:old'], baseline.allTime.sessions['codex:old']);
});

for (const deferLiveHistoryCapture of [false, true]) {
  test(`a legacy daily archive caches the absence of source snapshots (deferred live capture: ${deferLiveHistoryCapture})`, async t => {
    const options = optionsFor(t);
    const now = new Date(2026, 9, 11, 12);
    const archivePath = options.dailyHistoryArchiveOptions.path;
    fs.writeFileSync(archivePath, JSON.stringify({ version: 1, days: {} }));
    const originalRead = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = function (file, ...args) {
      if (String(file) === archivePath) reads++;
      return originalRead.call(this, file, ...args);
    };
    t.after(() => { fs.readFileSync = originalRead; });
    let cached;
    for (let i = 0; i < 5; i++) {
      await collectUsageOnce({ ...options, now, includeHistory: false, deferLiveHistoryCapture,
        sourceArchiveSnapshot: cached, onSourceArchiveComputed: value => { cached = value; },
        runTokscale: async () => ({ entries: deferLiveHistoryCapture ? [nativeRow('a', 100)] : [] }) });
    }
    assert.deepEqual(cached, { version: 2, accountingOwner: 'app', ownedClients: [], managedKeys: [], sessions: [] });
    assert.equal(reads, 1);
  });
}

for (const [cliId, desktopId] of [['a', 'b'], ['shared', 'shared']]) {
test(`collector projects independent raw source clients into one canonical partition (${cliId}/${desktopId})`, async t => {
  const options = { ...optionsFor(t), clients: 'devin' };
  const now = new Date(2026, 9, 11, 12);
  const today = localTodayKey(now);
  const nativeRows = [nativeRow(cliId, 300, 'devin-cli'), nativeRow(desktopId, 700, 'devin-desktop')];
  let captured;
  let cached;
  const full = await collectUsageOnce({ ...options, now, runTokscale: async () => ({ entries: nativeRows }),
    runGraph: async () => sourceGraph(now, [
      { client: 'devin-cli', sessionId: cliId, days: [contribution(today, 30, 'opus', 0.3, 'devin-cli')] },
      { client: 'devin-desktop', sessionId: desktopId, days: [contribution(today, 70, 'opus', 0.7, 'devin-desktop')] }
    ], { replacementClients: ['devin-cli', 'devin-desktop'] }),
    onAnchorComputed: value => { captured = value; }, onSourceArchiveComputed: value => { cached = value; } });
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(full[name].totalTokens, 100);
    assert.equal(full[name].sessions[`devin:${cliId}`].totalTokens, cliId === desktopId ? 100 : 30);
    assert.equal(full[name].sessions[`devin:${desktopId}`].totalTokens, cliId === desktopId ? 100 : 70);
  }
  const watch = await collectUsageOnce({ ...options, now, includeHistory: false, sourceArchiveSnapshot: cached,
    todayOnlyAnchor: anchorFrom(captured, now),
    runTokscale: async () => ({ entries: [nativeRow(cliId, 35, 'devin-cli'), nativeRow(desktopId, 70, 'devin-desktop')] }) });
  assert.equal(watch.allTime.totalTokens, 105);
});
}

test('partial antigravity-extension prevents canonical migration and preserves the native legacy anchor', async t => {
  const options = { ...optionsFor(t), clients: 'antigravity', runAntigravitySync: async () => {} };
  const now = new Date(2026, 9, 11, 12);
  const today = localTodayKey(now);
  let captured;
  let cached;
  const full = await collectUsageOnce({ ...options, now,
    runTokscale: async () => ({ entries: [nativeRow('cli', 900, 'antigravity-cli'), nativeRow('extension', 20, 'antigravity-extension')] }),
    runGraph: async () => sourceGraph(now, [
      { client: 'antigravity-cli', sessionId: 'cli', days: [contribution(today, 30, 'opus', 0.3, 'antigravity-cli')] },
      { client: 'antigravity-extension', sessionId: 'extension', days: [contribution(today, 5, 'opus', 0.05, 'antigravity-extension')] }
    ], { replacementClients: ['antigravity-cli'], partialClients: ['antigravity-extension'] }),
    onAnchorComputed: value => { captured = value; }, onSourceArchiveComputed: value => { cached = value; } });
  assert.deepEqual(cached.ownedClients, []);
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(full[name].totalTokens, 920);
    assert.equal(full[name].sessions['antigravity:cli'].totalTokens, 900);
    assert.equal(full[name].sessions['antigravity:extension'].totalTokens, 20);
    assert.equal(captured.windowsPeriods[name].totalTokens, 920);
  }
  assert.equal(full.history.summary.totalTokens, 920);
  const watch = await collectUsageOnce({ ...options, now, includeHistory: false, sourceArchiveSnapshot: cached,
    todayOnlyAnchor: anchorFrom(captured, now),
    runTokscale: async () => ({ entries: [nativeRow('cli', 35, 'antigravity-cli'), nativeRow('extension', 25, 'antigravity-extension')] }) });
  assert.equal(watch.allTime.totalTokens, 60);
});

for (const [cliId, desktopId] of [['old', 'live'], ['shared', 'shared']]) {
  test(`omitted raw source ID survives cached and disk watch projection (${cliId}/${desktopId})`, async t => {
    const options = { ...optionsFor(t), clients: 'devin' };
    const now = new Date(2026, 9, 11, 12);
    const today = localTodayKey(now);
    const cli = { client: 'devin-cli', sessionId: cliId, days: [contribution(today, 100, 'opus', 1, 'devin-cli')] };
    const desktop = { client: 'devin-desktop', sessionId: desktopId, days: [contribution(today, 5, 'opus', 0.05, 'devin-desktop')] };
    await collectUsageOnce({ ...options, now,
      runTokscale: async () => ({ entries: [nativeRow(cliId, 100, 'devin-cli'), nativeRow(desktopId, 5, 'devin-desktop')] }),
      runGraph: async () => sourceGraph(now, [cli, desktop], { replacementClients: ['devin-cli', 'devin-desktop'] }) });
    const later = new Date(now.getTime() + 60000);
    let captured;
    let cached;
    const full = await collectUsageOnce({ ...options, now: later,
      runTokscale: async () => ({ entries: [nativeRow(desktopId, 5, 'devin-desktop')] }),
      runGraph: async () => sourceGraph(later, [desktop], { replacementClients: ['devin-cli', 'devin-desktop'] }),
      onAnchorComputed: value => { captured = value; }, onSourceArchiveComputed: value => { cached = value; } });
    assert.equal(full.history.summary.totalTokens, 105);
    assert.equal(cached.sessions.find(row => row.client === 'devin-cli').sourceState, 'unknown');
    for (const name of ['today', 'month', 'allTime']) {
      assert.equal(full[name].totalTokens, 105);
      assert.equal(captured.windowsPeriods[name].totalTokens, 5);
      assert.deepEqual(captured.nativeRawPresence[name], [`devin-desktop:${desktopId}`]);
    }
    const anchor = JSON.parse(JSON.stringify(anchorFrom(captured, later)));
    for (const sourceArchiveSnapshot of [cached, undefined, cached]) {
      let scans = 0;
      const watch = await collectUsageOnce({ ...options, now: later, includeHistory: false, sourceArchiveSnapshot,
        todayOnlyAnchor: anchor,
        runTokscale: async ({ flags }) => {
          scans++;
          assert.deepEqual(flags, ['--today']);
          return { entries: [nativeRow(desktopId, 5, 'devin-desktop')] };
        } });
      assert.equal(scans, 1);
      for (const name of ['today', 'month', 'allTime']) {
        assert.equal(watch[name].totalTokens, 105);
        assert.equal(watch[name].sessions[`devin:${cliId}`].totalTokens, cliId === desktopId ? 105 : 100);
        assert.equal(watch[name].sessions[`devin:${desktopId}`].totalTokens, cliId === desktopId ? 105 : 5);
      }
    }
  });
}

test('collector persists raw native presence across restart and targeted watch ticks', async t => {
  const options = { ...optionsFor(t), clients: 'devin,claude', watchEnabled: false, sessionActivityPolling: false,
    intervalMs: 60 * 60 * 1000, limitsEnabled: false };
  const priorDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = options.homeDir;
  let handle;
  t.after(async () => {
    handle?.stop();
    await handle?.whenIdle();
    if (priorDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = priorDir;
  });
  const now = new Date();
  const today = localTodayKey(now);
  const cli = { client: 'devin-cli', sessionId: 'shared', days: [contribution(today, 100, 'opus', 1, 'devin-cli')] };
  const desktop = { client: 'devin-desktop', sessionId: 'shared', days: [contribution(today, 5, 'opus', 0.05, 'devin-desktop')] };
  let omitted = false;
  let graphSequence = 0;
  let scans = [];
  const updates = [];
  const runtimeOptions = { ...options, now,
    runTokscale: async ({ clients, flags }) => {
      scans.push({ clients, flags });
      const requested = new Set(clients.split(','));
      return { entries: [
        ...(requested.has('devin') ? [
          ...(!omitted ? [nativeRow('shared', 100, 'devin-cli')] : []), nativeRow('shared', 5, 'devin-desktop')
        ] : []), ...(requested.has('claude') ? [nativeRow('c', 3)] : [])
      ] };
    },
    runGraph: async () => sourceGraph(new Date(now.getTime() + ++graphSequence * 1000), [...(!omitted ? [cli] : []), desktop,
      { client: 'claude', sessionId: 'c', days: [contribution(today, 3)] }
    ], { replacementClients: ['devin-cli', 'devin-desktop', 'claude'] }),
    onUpdate: summary => { updates.push(summary); }, onError: error => { throw error; } };
  handle = startCollector(runtimeOptions);
  await handle.whenIdle();
  assert.equal(updates.length, 1);
  assert.equal(updates[0].allTime.totalTokens, 108);
  omitted = true;
  await handle.tick('manual', { forceHistory: true });
  assert.equal(updates.at(-1).allTime.totalTokens, 108);
  handle.stop();
  await handle.whenIdle();
  const saved = JSON.parse(fs.readFileSync(path.join(options.homeDir, 'collector-anchor.json'), 'utf8'));
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(saved[name].totalTokens, 8);
    assert.deepEqual(saved.nativeRawPresence[name].sort(), ['claude:c', 'devin-desktop:shared']);
  }
  scans = [];
  handle = startCollector({ ...runtimeOptions, historyEnabled: false,
    runGraph: async () => { throw new Error('restart must use the persisted source archive'); } });
  await handle.whenIdle();
  assert.equal(scans.length, 1);
  assert.deepEqual(scans[0].flags, ['--today']);
  assert.equal(updates.at(-1).allTime.totalTokens, 108);
  for (const client of ['claude', 'devin', 'claude']) {
    const priorScans = scans.length;
    await handle.refreshClient(client);
    assert.equal(scans.length, priorScans + 1);
    assert.deepEqual(scans.at(-1), { clients: client, flags: ['--today'] });
    for (const name of ['today', 'month', 'allTime']) {
      assert.equal(updates.at(-1)[name].totalTokens, 108);
      assert.equal(updates.at(-1)[name].sessions['devin:shared'].totalTokens, 105);
    }
  }
  handle.stop();
  await handle.whenIdle();
  delete saved.nativeRawPresence;
  fs.writeFileSync(path.join(options.homeDir, 'collector-anchor.json'), JSON.stringify(saved));
  scans = [];
  handle = startCollector({ ...runtimeOptions, historyEnabled: false });
  await handle.whenIdle();
  assert.equal(scans.length, 3, 'an old canonical-only anchor must rebuild raw presence once');
  assert.equal(updates.at(-1).allTime.totalTokens, 108);
});

test('a returning raw alias adds its past days even when a canonical sibling was already native', async t => {
  const options = { ...optionsFor(t), clients: 'devin' };
  const now = new Date(2026, 9, 11, 12);
  const today = localTodayKey(now);
  const yesterday = localTodayKey(new Date(2026, 9, 10, 12));
  const cli = { client: 'devin-cli', sessionId: 'shared', days: [contribution(yesterday, 100, 'opus', 1, 'devin-cli')] };
  const desktop = { client: 'devin-desktop', sessionId: 'shared', days: [contribution(today, 5, 'opus', 0.05, 'devin-desktop')] };
  await collectUsageOnce({ ...options, now, runTokscale: async ({ flags }) => ({ entries: [
    ...(!flags.includes('--today') ? [nativeRow('shared', 100, 'devin-cli')] : []), nativeRow('shared', 5, 'devin-desktop')
  ] }), runGraph: async () => sourceGraph(now, [cli, desktop], { replacementClients: ['devin-cli', 'devin-desktop'] }) });
  const later = new Date(now.getTime() + 60000);
  let captured;
  let cached;
  const full = await collectUsageOnce({ ...options, now: later,
    runTokscale: async () => ({ entries: [nativeRow('shared', 5, 'devin-desktop')] }),
    runGraph: async () => sourceGraph(later, [desktop], { replacementClients: ['devin-cli', 'devin-desktop'] }),
    onAnchorComputed: value => { captured = value; }, onSourceArchiveComputed: value => { cached = value; } });
  assert.equal(full.today.totalTokens, 5);
  assert.equal(full.allTime.totalTokens, 105);
  const anchor = anchorFrom(captured, later);
  for (const amount of [20, 25, 25]) {
    const watch = await collectUsageOnce({ ...options, now: later, includeHistory: false, sourceArchiveSnapshot: cached,
      todayOnlyAnchor: anchor, runTokscale: async () => ({ entries: [
        nativeRow('shared', amount, 'devin-cli'), nativeRow('shared', 5, 'devin-desktop')
      ] }) });
    assert.equal(watch.today.totalTokens, amount + 5);
    for (const name of ['month', 'allTime']) {
      assert.equal(watch[name].totalTokens, amount + 105);
      assert.equal(watch[name].sessions['devin:shared'].totalTokens, amount + 105);
    }
  }
});

for (const graphSucceeds of [true, false]) {
  for (const knownHealthy of [true, false]) test(`prior-day omitted rows survive midnight; graph=${graphSucceeds}, healthy snapshot=${knownHealthy}`, async t => {
    const options = optionsFor(t);
    const yesterday = new Date(2026, 9, 10, 12);
    const now = new Date(2026, 9, 11, 12);
    const yesterdayKey = localTodayKey(yesterday);
    let previous;
    await collectUsageOnce({ ...options, now: yesterday,
      runTokscale: async () => ({ entries: [nativeRow('a', 100)] }),
      runGraph: async () => sourceGraph(yesterday, [{ client: 'claude', sessionId: 'a', days: [contribution(yesterdayKey, 100)] }]),
      onSourceArchiveComputed: value => { previous = value; } });
    let captured;
    let cached;
    const full = await collectUsageOnce({ ...options, now, sourceArchiveSnapshot: knownHealthy ? previous : undefined,
      runTokscale: async () => ({ entries: [] }), runGraph: async () => {
        if (!graphSucceeds) throw new Error('graph failed after midnight');
        return sourceGraph(now, []);
      }, onAnchorComputed: value => { captured = value; }, onSourceArchiveComputed: value => { cached = value; } });
    const locked = !graphSucceeds && !knownHealthy;
    assert.equal(cached.scopes[0].blockNativeWatch === true, locked);
    assert.equal(cached.sessions[0].days[0].date, yesterdayKey, 'omission preserves the timestamped contribution');
    assert.equal(cached.scopes[0].acceptedAt, (graphSucceeds ? now : yesterday).toISOString());
    assert.equal(full.history.summary.totalTokens, 100);
    assert.equal(full.today.totalTokens, 0);
    for (const name of ['month', 'allTime']) {
      assert.equal(full[name].totalTokens, 100);
      assert.equal(full[name].sessions['claude:a'].sourceState, 'unknown');
      assert.equal(captured.windowsPeriods[name].totalTokens, 0);
    }
    for (const sourceArchiveSnapshot of [cached, undefined]) {
      const retained = await collectUsageOnce({ ...options, now, includeHistory: false, sourceArchiveSnapshot,
        todayOnlyAnchor: anchorFrom(captured, now), runTokscale: async () => ({ entries: [] }) });
      assert.equal(retained.today.totalTokens, 0);
      assert.equal(retained.month.totalTokens, 100);
      assert.equal(retained.allTime.totalTokens, 100);
      const watch = await collectUsageOnce({ ...options, now, includeHistory: false, sourceArchiveSnapshot,
        todayOnlyAnchor: anchorFrom(captured, now), runTokscale: async () => ({ entries: [nativeRow('a', 5)] }) });
      assert.equal(watch.today.totalTokens, locked ? 0 : 5);
      assert.equal(watch.month.totalTokens, locked ? 100 : 105);
      assert.equal(watch.allTime.totalTokens, locked ? 100 : 105);
    }
    const recoveredAt = new Date(now.getTime() + 1000);
    const recovered = await collectUsageOnce({ ...options, now: recoveredAt, sourceArchiveSnapshot: cached,
      runTokscale: async ({ flags }) => ({ entries: [nativeRow('a', flags.includes('--today') ? 5 : 105)] }),
      runGraph: async () => sourceGraph(recoveredAt, [{ client: 'claude', sessionId: 'a',
        days: [contribution(yesterdayKey, 100), contribution(localTodayKey(now), 5)] }]),
      onAnchorComputed: value => { captured = value; }, onSourceArchiveComputed: value => { cached = value; } });
    assert.equal(recovered.today.totalTokens, 5);
    assert.equal(recovered.allTime.totalTokens, 105);
    assert.notEqual(cached.scopes[0].blockNativeWatch, true);
    const growing = await collectUsageOnce({ ...options, now: recoveredAt, includeHistory: false,
      sourceArchiveSnapshot: cached, todayOnlyAnchor: anchorFrom(captured, recoveredAt),
      runTokscale: async () => ({ entries: [nativeRow('a', 6)] }) });
    assert.equal(growing.today.totalTokens, 6);
    assert.equal(growing.allTime.totalTokens, 106);
  });
}

test('unidentified events freeze accepted accounting until a complete exact ownership transfer', async t => {
  const options = optionsFor(t);
  const now = new Date(2026, 9, 11, 12);
  const today = localTodayKey(now);
  const initialRows = ['a', 'b'].map(sessionId => ({ client: 'claude', sessionId,
    days: [contribution(today, sessionId === 'a' ? 100 : 50)] }));
  const initialGraph = sourceGraph(now, initialRows);
  const first = await collectUsageOnce({ ...options, now,
    runTokscale: async () => ({ entries: [nativeRow('a', 100), nativeRow('b', 50)] }),
    runGraph: async () => initialGraph });
  const sessionArchive = updateSessionUsageArchive({}, first, now).archive;
  const later = new Date(now.getTime() + 60000);
  const unidentified = sourceGraph(later, [{ client: 'claude', sessionId: 'a', days: [contribution(today, 40)] }]);
  unidentified.sourceUsage.sessions[0].events[0].id = null;
  let captured;
  let cached;
  const rejected = await collectUsageOnce({ ...options, now: later,
    runTokscale: async () => ({ entries: [nativeRow('a', 40)] }), runGraph: async () => unidentified,
    onAnchorComputed: value => { captured = value; }, onSourceArchiveComputed: value => { cached = value; } });
  assert.equal(rejected.history.summary.totalTokens, 150);
  assert.equal(rejected.allTime.totalTokens, 150);
  assert.equal(applySessionUsageArchive(rejected, sessionArchive, { now: later }).allTime.totalTokens, 150);
  const newest = new Date(later.getTime() + 60000);
  const moved = sourceGraph(newest, [
    { client: 'claude', sessionId: 'a', days: [] },
    { client: 'claude', sessionId: 'new', days: [contribution(today, 2)] }
  ]);
  moved.sourceUsage.sessions[1].events[0].id = initialGraph.sourceUsage.sessions[0].events[0].id;
  const corrected = await collectUsageOnce({ ...options, now: newest,
    runTokscale: async () => ({ entries: [nativeRow('new', 2)] }), runGraph: async () => moved,
    onAnchorComputed: value => { captured = value; }, onSourceArchiveComputed: value => { cached = value; } });
  assert.equal(corrected.history.summary.totalTokens, 52);
  assert.equal(corrected.allTime.totalTokens, 52);
  assert.equal(corrected.allTime.sessions['claude:a'], undefined);
  assert.equal(corrected.allTime.sessions['claude:b'].totalTokens, 50);
  assert.equal(corrected.allTime.sessions['claude:new'].totalTokens, 2);
  assert.equal(applySessionUsageArchive(corrected, sessionArchive, { now: newest }).allTime.totalTokens, 52);
  for (const sourceArchiveSnapshot of [cached, undefined]) {
    const watch = await collectUsageOnce({ ...options, now: newest, includeHistory: false, sourceArchiveSnapshot,
      todayOnlyAnchor: anchorFrom(captured, newest), runTokscale: async () => ({ entries: [nativeRow('new', 2)] }) });
    for (const name of ['today', 'month', 'allTime']) assert.equal(watch[name].totalTokens, 52);
  }
});
