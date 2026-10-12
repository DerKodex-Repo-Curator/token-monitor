'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectUsageOnce, startCollector, localTodayKey } = require('../../src/shared/collector');
const { extractUsageFromTokscale, mergePeriods } = require('../../src/shared/usage');
const { createUsageTransform } = require('../../src/shared/usage/usageTransform');
const { createSessionUsageArchiveStore } = require('../../src/shared/usage/sessionUsageArchiveStore');
const { createLocalUsageStore } = require('../../src/shared/providers/codex/localUsageStore');
const { execFileSync } = require('node:child_process');

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const now = new Date(2026, 9, 12, 12);
const row = (client, sessionId, input = 100, cost = 1) => ({ client, sessionId, input, cost, model: 'fixture-model' });
const period = (rows) => extractUsageFromTokscale({ entries: rows });
function graph(rows, clock = now, status = 'complete', timeZone = zone) {
  const date = localTodayKey(now, timeZone);
  return { contributions: rows.map(value => ({ date, clients: [{ client: value.client,
    modelId: value.model, providerId: 'provider', cost: value.cost, messages: 1,
    tokens: { input: value.input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }] })),
    sourceUsage: { version: 2, eventIdentityVersion: 2, capturedAt: clock.toISOString(), fullHistory: true,
      bucketTimezone: timeZone, replacementClients: ['codex'], partialClients: [], rowsWithoutIdentity: {},
      scopes: [{ id: 'codex', clients: ['codex'], readStatus: status, identityStatus: 'exact' }],
      sessions: rows.map(value => ({ client: value.client, sessionId: value.sessionId, scopeId: 'codex', events: [{
        id: `event:${value.sessionId}`, contributions: [{ timestamp: now.getTime(), modelId: value.model,
          providerId: 'provider', cost: value.cost, messages: 1,
          tokens: { input: value.input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }]
      }] })) } };
}
function fixture(t, clients = 'codex') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'source-ledger-integration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, options: { clients, allTimeSince: '2020-01-01', deviceId: 'integration', now,
    homeDir: directory, env: {}, projectsEnabled: false, wslScanEnabled: false, codexLocalUsageEnabled: false,
    includeHistory: true, dailyHistoryArchiveEnabled: true, sessionUsageArchive: { version: 1, sessions: {} },
    dailyHistoryArchiveOptions: { path: path.join(directory, 'daily.json') },
    sessionMetadataDeps: { resolveSessionMetadata: () => null } } };
}
function assertPeriods(summary, expected) {
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(summary[name].totalTokens, expected, name);
    assert.equal(Object.values(summary[name].sessions).reduce((sum, value) => sum + value.totalTokens, 0), expected, `${name} allocation`);
  }
}

for (const legacy of [false, true]) test(`progressive collector does not create migration evidence; existing legacy=${legacy}`, async t => {
  const f = fixture(t);
  const store = createSessionUsageArchiveStore({ databasePath: path.join(f.directory, 'sessions.sqlite'), path: path.join(f.directory, 'sessions.json') });
  const transform = createUsageTransform({ store, readSnapshot: () => store.readMigrationEvidence() });
  let tokens = 100, clock = now;
  const summary = () => ({ updatedAt: clock.toISOString(), ...Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, period([row('codex', 'native', tokens)])])) });
  if (legacy) store.capture({ ...summary(), ...Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, period([row('codex', 'old', 200, 2)])])) }, now);
  const evidence = [], output = [];
  let previews = 0;
  const collector = startCollector({ ...f.options, sessionUsageArchive: undefined, includeHistory: undefined,
    now: () => clock, anchorPersistenceEnabled: false, watchEnabled: false, sessionActivityPolling: false,
    intervalMs: 3600000, historyEnabled: true, deferLiveHistoryCapture: true,
    getSessionUsageArchive: () => { const value = store.readMigrationEvidence(); evidence.push(Object.keys(value.sessions).length); return value; },
    runTokscale: async () => ({ entries: [row('codex', 'native', tokens)] }),
    runGraph: async () => graph([row('codex', 'native', tokens)], clock),
    onPreview: preview => { previews++; transform.transform(preview, 'progress', { preview: true }); },
    onUpdate: value => output.push(transform.transform(value)), logger: () => {} });
  try {
    await collector.whenIdle();
    tokens = 20; clock = new Date(now.getTime() + 1000);
    await collector.tick('manual', { forceHistory: true });
    assert.ok(previews >= 4);
    assert.equal(evidence[0], legacy ? 1 : 0);
    output.forEach((value, index) => assertPeriods(value, legacy ? 200 : index ? 20 : 100));
    const scope = JSON.parse(fs.readFileSync(f.options.dailyHistoryArchiveOptions.path)).sourceLedger.scopes.codex;
    assert.equal(scope.mode, legacy ? 'legacy' : 'ledger');
  } finally { collector.stop(); await collector.whenIdle(); store.close(); }
});

for (const client of ['gemini', 'codex']) test(`native projection preserves separate WSL ${client} on full/noHistory/locked watch`, async t => {
  const f = fixture(t, 'codex,gemini');
  let status = 'complete', clock = now, projection, captured;
  const bundle = Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, period([row(client, 'wsl', 9, 0.09)])]));
  const options = { ...f.options, wslScanEnabled: true,
    runTokscale: async () => ({ entries: [row('codex', 'native')] }),
    runGraph: async () => graph([row('codex', 'native')], clock, status),
    collectWslUsage: async () => ({ bundle, detected: [client] }),
    onSourceArchiveComputed: value => { projection = value; }, onAnchorComputed: value => { captured = value; } };
  assertPeriods(await collectUsageOnce(options), 109);
  assertPeriods(await collectUsageOnce({ ...options, includeHistory: false, sourceArchiveSnapshot: projection }), 109);
  status = 'partial'; clock = new Date(now.getTime() + 1000);
  assertPeriods(await collectUsageOnce({ ...options, now: clock }), 109);
  assert.equal(projection.scopes[0].blockNativeWatch, true);
  const anchor = { ...captured.windowsPeriods, dateKey: captured.dateKey, timeZone: captured.timeZone,
    todayPartitions: captured.todayPartitions, nativeRawPresence: captured.nativeRawPresence };
  const watch = await collectUsageOnce({ ...options, now: new Date(now.getTime() + 2000), includeHistory: false,
    sourceArchiveSnapshot: projection, todayOnlyAnchor: anchor, wslAnchor: bundle });
  assertPeriods(watch, 109);
  assert.equal(watch.allTime.sessions[`${client}:wsl`].totalTokens, 9);
});

test('Dots real SQLite request ledger survives native noHistory and locked watch projection', async t => {
  const f = fixture(t);
  const store = createLocalUsageStore({ databasePath: path.join(f.directory, 'dots.sqlite') });
  t.after(() => store.close());
  const id = '01234567-1234-1234-1234-123456789abc';
  const environment = { id: 'local-env', executorId: 'local-executor', executorLabel: 'this computer', type: 'local', cwd: '/fixture' };
  const tokens = { inputTokens: 9, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 9 };
  store.observe({ accountKey: 'fixture-account', thread: { id, sessionId: 'ancestor', threadSource: 'cli', executorId: 'local-executor', model: 'fixture-model', environments: [environment] },
    ...environment, turnId: 'turn-1', tokenUsage: { last: tokens, total: tokens }, now: now.toISOString() });
  assert.equal(store.rows().length, 1);
  let projection, captured, status = 'complete';
  const options = { ...f.options, codexLocalUsageEnabled: true, codexLocalUsageStore: store,
    lookupModelPricing: async () => ({}),
    runTokscale: async () => ({ entries: [row('codex', 'native')] }),
    runGraph: async () => graph([row('codex', 'native')], new Date(now.getTime() + 1000), status),
    onSourceArchiveComputed: value => { projection = value; }, onAnchorComputed: value => { captured = value; } };
  assertPeriods(await collectUsageOnce(options), 109);
  assertPeriods(await collectUsageOnce({ ...options, includeHistory: false, sourceArchiveSnapshot: projection }), 109);
  status = 'partial';
  assertPeriods(await collectUsageOnce(options), 109);
  assert.equal(projection.scopes[0].blockNativeWatch, true);
  const anchor = { ...captured.windowsPeriods, dateKey: captured.dateKey, timeZone: captured.timeZone, todayPartitions: captured.todayPartitions };
  assertPeriods(await collectUsageOnce({ ...options, includeHistory: false, todayOnlyAnchor: anchor, sourceArchiveSnapshot: projection }), 109);
});

for (const aggregate of [false, true]) test(`raw partition fallback does not crash History; aggregate=${aggregate}`, async t => {
  const f = fixture(t, 'codex,claude');
  const rows = Array.from({ length: 20000 }, (_, i) => row(i % 2 ? 'claude' : 'codex', `session-${i}`, 1, 0.1));
  const payload = aggregate ? { totalTokens: 100, cost: 1 } : { entries: rows };
  if (!aggregate) assert.ok(Math.abs(mergePeriods(period(rows.filter(value => value.client === 'codex')), period(rows.filter(value => value.client === 'claude'))).costUsd - period(rows).costUsd) > 1e-9);
  const result = await collectUsageOnce({ ...f.options, runTokscale: async () => payload, runGraph: async () => ({ contributions: [] }) });
  assert.equal(result.allTime.totalTokens, aggregate ? 100 : 20000);
  assert.ok(result.history);
  if (!aggregate) assert.equal(Object.keys(result.allTime.sessions).length, 20000);
});

test('unavailable raw inventory cannot grant new ownership or down-correct accepted accounting', async t => {
  const f = fixture(t);
  let projection;
  const options = { ...f.options, onSourceArchiveComputed: value => { projection = value; } };
  await collectUsageOnce({ ...options, runTokscale: async () => ({ totalTokens: 100, cost: 1 }), runGraph: async () => graph([row('codex', 'native', 20, 0.2)]) });
  assert.deepEqual(projection.ownedClients, []);
  // A fresh archive accepts identified100; subsequent aggregate-only output
  // cannot authorize an exact20 correction, despite a healthy export DTO.
  fs.rmSync(f.options.dailyHistoryArchiveOptions.path);
  assertPeriods(await collectUsageOnce({ ...options, runTokscale: async () => ({ entries: [row('codex', 'native')] }), runGraph: async () => graph([row('codex', 'native')]) }), 100);
  const retained = await collectUsageOnce({ ...options, runTokscale: async () => ({ totalTokens: 20, cost: 0.2 }), runGraph: async () => graph([row('codex', 'native', 20, 0.2)], new Date(now.getTime() + 1000)) });
  assertPeriods(retained, 100);
  assert.equal(projection.scopes[0].blockNativeWatch, true);
});

test('material raw closure mismatch remains unresolved, including overlapping canonical aliases', async t => {
  const f = fixture(t, 'devin');
  const source = graph([row('devin-cli', 'cli', 20)], now);
  source.sourceUsage.replacementClients = ['devin-cli'];
  source.sourceUsage.scopes = [{ id: 'cli-domain', clients: ['devin-cli'], readStatus: 'complete', identityStatus: 'exact' }];
  source.sourceUsage.sessions[0].scopeId = 'cli-domain';
  let projection;
  // A supported nested report row is outside the literal entries inventory.
  // Neither missing tokens nor a material monetary mismatch is roundoff.
  const payload = { entries: [row('devin-cli', 'cli', 20, 0.2)], extra: [row('devin-desktop', 'desktop', 9, 50)] };
  const result = await collectUsageOnce({ ...f.options, runTokscale: async () => payload,
    runGraph: async () => source, onSourceArchiveComputed: value => { projection = value; } });
  assert.equal(result.allTime.totalTokens, 29);
  assert.equal(result.allTime.costUsd, 50.2);
  assert.deepEqual(projection.ownedClients, []);
  const stored = JSON.parse(fs.readFileSync(f.options.dailyHistoryArchiveOptions.path));
  assert.equal(stored.sourceLedger.observations['cli-domain'].reason, 'native-accounting-unavailable');
});

test('pinned-zone calendar, DST boundaries and persisted anchors use the native window', () => {
  // Separate process so changing TZ cannot affect another test's fixture.
  const script = `const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
    const {computePeriodWindows,collectorAnchorTrust,configFingerprint}=require(${JSON.stringify(require.resolve('../../src/shared/collector'))});
    const {deviceRecordFromAnchor}=require(${JSON.stringify(require.resolve('../../src/shared/anchorSeed'))});
    const {emptyPeriod}=require(${JSON.stringify(require.resolve('../../src/shared/usage'))});
    const home=fs.mkdtempSync(path.join(os.tmpdir(),'pinned-anchor-'));
    try {
      fs.mkdirSync(path.join(home,'.config/tokscale'),{recursive:true});
      fs.writeFileSync(path.join(home,'.config/tokscale/settings.json'),JSON.stringify({scanner:{bucketTimezone:'America/Los_Angeles'}}));
      for(const [at,key,end] of [['2026-10-12T04:00Z','2026-10-11','2026-10-12T07:00:00.000Z'],['2026-03-08T10:00Z','2026-03-08','2026-03-09T07:00:00.000Z'],['2026-11-01T09:00Z','2026-11-01','2026-11-02T08:00:00.000Z'],['2026-11-01T06:00Z','2026-10-31','2026-11-01T07:00:00.000Z']]){
        const windows=computePeriodWindows(new Date(at),'America/Los_Angeles'); assert.equal(windows.today.key,key);assert.equal(windows.today.endsAt,end);
      }
      const opts={homeDir:home,env:{},dailyHistoryArchiveEnabled:true,clients:'codex',allTimeSince:'2020-01-01',now:new Date('2026-10-12T04:00Z'),pricingRevision:'fixed'};
      const saved={dateKey:'2026-10-11',timeZone:'America/Los_Angeles',today:emptyPeriod(),month:emptyPeriod(),allTime:emptyPeriod(),configFingerprint:configFingerprint('codex','2020-01-01',true,'','',null,'fixed'),fullScanAt:'2026-10-12T03:00Z'};
      assert.ok(collectorAnchorTrust(saved,opts));assert.equal(deviceRecordFromAnchor(saved,opts).periodWindows.today.key,'2026-10-11');
      assert.equal(collectorAnchorTrust({...saved,timeZone:undefined},opts),null);
      assert.equal(collectorAnchorTrust(saved,{...opts,now:new Date('2026-10-12T07:00Z')}),null);
      assert.ok(collectorAnchorTrust(saved,{...opts,now:new Date('2026-10-12T00:00Z')}));
      fs.writeFileSync(path.join(home,'.config/tokscale/settings.json'),JSON.stringify({scanner:{bucketTimezone:'UTC'}}));
      assert.equal(collectorAnchorTrust(saved,opts),null);
      fs.writeFileSync(path.join(home,'.config/tokscale/settings.json'),JSON.stringify({scanner:{bucketTimezone:' America/Los_Angeles '} }));
      assert.ok(collectorAnchorTrust(saved,opts));
      fs.writeFileSync(path.join(home,'.config/tokscale/settings.json'),JSON.stringify({scanner:{bucketTimezone:' '} }));
      assert.equal(collectorAnchorTrust(saved,opts),null);
      const legacyPath=path.join(home,'Library/Application Support/tokscale/settings.json');
      fs.mkdirSync(path.dirname(legacyPath),{recursive:true});fs.writeFileSync(legacyPath,JSON.stringify({scanner:{bucketTimezone:'America/Los_Angeles'}}));
      fs.rmSync(path.join(home,'.config/tokscale/settings.json'));
      assert.ok(collectorAnchorTrust(saved,{...opts,platform:'darwin'}));
      fs.writeFileSync(path.join(home,'.config/tokscale/settings.json'),'{malformed');
      assert.equal(collectorAnchorTrust(saved,{...opts,platform:'darwin'}),null);
      fs.rmSync(path.join(home,'.config/tokscale/settings.json'));
      fs.mkdirSync(path.join(home,'.config/tokscale/settings.json'));
      assert.ok(collectorAnchorTrust(saved,{...opts,platform:'darwin'}));
      assert.equal(collectorAnchorTrust(saved,{...opts,platform:'darwin',env:{TOKSCALE_CONFIG_DIR:path.join(home,'.config/tokscale')}}),null);
      fs.rmSync(path.join(home,'.config/tokscale/settings.json'),{recursive:true});
      assert.equal(collectorAnchorTrust(saved,{...opts,platform:'darwin',env:{TOKSCALE_CONFIG_DIR:path.join(home,'override')}}),null);
    }finally{fs.rmSync(home,{recursive:true,force:true});}`;
  execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'UTC' } });
});

test('pinned full and unchanged/append watch use one day and exact deltas', async t => {
  const f = fixture(t);
  const pin = zone === 'UTC' ? 'America/Los_Angeles' : 'UTC';
  fs.mkdirSync(path.join(f.directory, '.config/tokscale'), { recursive: true });
  fs.writeFileSync(path.join(f.directory, '.config/tokscale/settings.json'), JSON.stringify({ scanner: { bucketTimezone: pin } }));
  const clock = new Date('2026-10-12T04:00Z');
  let input = 100, projection, captured;
  const options = { ...f.options, now: clock,
    runTokscale: async () => ({ entries: [row('codex', 'native', input)] }),
    runGraph: async () => ({ contributions: [], sourceUsage: { ...graph([row('codex', 'native', input)], clock, 'complete', pin).sourceUsage,
      sessions: [{ client: 'codex', sessionId: 'native', scopeId: 'codex', events: [{ id: 'one', contributions: [{ timestamp: clock.getTime() - 1000,
        modelId: 'fixture-model', providerId: 'provider', cost: 1, messages: 1, tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } }] }] }] } }),
    onSourceArchiveComputed: value => { projection = value; }, onAnchorComputed: value => { captured = value; } };
  const full = await collectUsageOnce(options); assertPeriods(full, 100);
  const anchor = { ...captured.windowsPeriods, dateKey: captured.dateKey, timeZone: captured.timeZone, todayPartitions: captured.todayPartitions, nativeRawPresence: captured.nativeRawPresence };
  assert.equal(full.periodWindows.timeZone, pin);
  const watchOptions = { ...options, includeHistory: false, sourceArchiveSnapshot: projection, todayOnlyAnchor: anchor };
  assertPeriods(await collectUsageOnce(watchOptions), 100);
  input = 120;
  assertPeriods(await collectUsageOnce(watchOptions), 120);
  assertPeriods(await collectUsageOnce(watchOptions), 120);
});

for (const setting of ['unreadable-primary', 'padded-pin']) test(`scanner setting ${setting} stays aligned on full and unchanged watch`, () => {
  const script = `const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
    const {collectUsageOnce}=require(${JSON.stringify(require.resolve('../../src/shared/collector'))});
    const home=fs.mkdtempSync(path.join(os.tmpdir(),'pinned-unreadable-'));
    (async()=>{try{
      const primary=path.join(home,'.config/tokscale/settings.json');
      fs.mkdirSync(path.dirname(primary),{recursive:true});
      if(${JSON.stringify(setting)}==='unreadable-primary')fs.mkdirSync(primary);
      else fs.writeFileSync(primary,JSON.stringify({scanner:{bucketTimezone:' America/Los_Angeles '}}));
      const legacy=path.join(home,'Library/Application Support/tokscale/settings.json');
      fs.mkdirSync(path.dirname(legacy),{recursive:true});
      fs.writeFileSync(legacy,JSON.stringify({scanner:{bucketTimezone:'America/Los_Angeles'}}));
      const values=[['old','2026-10-11T23:30Z',100],['new','2026-10-12T01:00Z',20]];
      let captured,projection;
      const options={homeDir:home,env:{},platform:'darwin',clients:'codex',allTimeSince:'2020-01-01',deviceId:'fixture',
        now:'2026-10-12T04:00Z',includeHistory:true,dailyHistoryArchiveEnabled:true,projectsEnabled:false,
        wslScanEnabled:false,codexLocalUsageEnabled:false,sessionUsageArchive:{version:1,sessions:{}},
        dailyHistoryArchiveOptions:{path:path.join(home,'daily.json')},sessionMetadataDeps:{resolveSessionMetadata:()=>null},
        runTokscale:async()=>({entries:values.map(([sessionId,,input])=>({client:'codex',sessionId,input,cost:input/100,model:'fixture-model'}))}),
        runGraph:async()=>({contributions:[],sourceUsage:{version:2,eventIdentityVersion:2,capturedAt:'2026-10-12T04:00Z',fullHistory:true,
          bucketTimezone:'America/Los_Angeles',replacementClients:['codex'],partialClients:[],rowsWithoutIdentity:{},
          scopes:[{id:'codex',clients:['codex'],readStatus:'complete',identityStatus:'exact'}],
          sessions:values.map(([sessionId,timestamp,input])=>({client:'codex',sessionId,scopeId:'codex',events:[{id:sessionId,
            contributions:[{timestamp:Date.parse(timestamp),modelId:'fixture-model',providerId:'provider',cost:input/100,messages:1,
              tokens:{input,output:0,cacheRead:0,cacheWrite:0,reasoning:0}}]}]}))}}),
        onAnchorComputed:value=>{captured=value;},onSourceArchiveComputed:value=>{projection=value;}};
      const check=value=>{for(const name of ['today','month','allTime']){
        assert.equal(value[name].totalTokens,120,name);
        assert.equal(Object.values(value[name].sessions).reduce((sum,row)=>sum+row.totalTokens,0),120,name+' allocation');}}
      const full=await collectUsageOnce(options);check(full);
      assert.equal(full.periodWindows.timeZone,'America/Los_Angeles');
      const anchor={...captured.windowsPeriods,dateKey:captured.dateKey,timeZone:captured.timeZone,
        todayPartitions:captured.todayPartitions,nativeRawPresence:captured.nativeRawPresence};
      for(let i=0;i<2;i++)check(await collectUsageOnce({...options,includeHistory:false,sourceArchiveSnapshot:projection,todayOnlyAnchor:anchor}));
    }finally{fs.rmSync(home,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});`;
  execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'UTC' } });
});
