'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { collectUsageOnce } = require('../../src/shared/collector');

const binary = process.env.TOKEN_MONITOR_SOURCE_LEDGER_TEST_BINARY;
for (const failure of ['array', 'timestamp', 'root', 'data', 'result', 'response', 'reasoning-subset', 'cache-subset', 'total-mismatch', 'symlink']) {
  test(`actual Codex export protects accepted accounting across ${failure} correction`, { skip: !binary || failure === 'symlink' && process.platform === 'win32' }, async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'source-review-cli-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const config = path.join(home, 'config');
    fs.mkdirSync(path.join(config, 'cache'), { recursive: true });
    const payload = JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), data: {} });
    for (const name of ['pricing-litellm.json', 'pricing-openrouter.json', 'pricing-models-dev.json']) {
      fs.writeFileSync(path.join(config, 'cache', name), payload);
    }
    fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ scanner: { bucketTimezone: 'UTC' } }));
    const directory = path.join(home, '.codex/sessions');
    fs.mkdirSync(directory, { recursive: true });
    const id = '01900000-0000-7000-8000-000000000001';
    const file = path.join(directory, `rollout-2026-03-02-${id}.jsonl`);
    const target = path.join(home, 'linked-target.jsonl');
    const link = path.join(directory, 'rollout-2026-03-02-01900000-0000-7000-8000-000000000002.jsonl');
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('TOKSCALE_') || key.startsWith('TOKEN_MONITOR_') || ['CODEX_HOME', 'CLAUDE_CONFIG_DIR'].includes(key)) delete env[key];
    }
    Object.assign(env, { HOME: home, TOKSCALE_CONFIG_DIR: config, TOKSCALE_PRICING_CACHE_ONLY: '1',
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share') });
    const run = args => JSON.parse(execFileSync(binary, ['--home', home, ...args, '--no-spinner'], {
      env, encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024
    }));
    function write(tokens, malformed = false) {
      const usage = { timestamp: '2026-03-02T18:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: tokens }, total_token_usage: { input_tokens: tokens }
      } } };
      if (malformed && failure === 'array') usage.payload.info = [null, null, null, { input_tokens: -1 }, null];
      if (malformed && failure === 'timestamp') usage.timestamp = 'invalid-timestamp';
      if (malformed && ['reasoning-subset', 'cache-subset', 'total-mismatch'].includes(failure)) {
        const counters = failure === 'reasoning-subset'
          ? { input_tokens: 0, output_tokens: 15, reasoning_output_tokens: 30, total_tokens: 45 }
          : failure === 'cache-subset'
            ? { input_tokens: 15, cached_input_tokens: 45, total_tokens: 45 }
            : { input_tokens: 15, total_tokens: 45 };
        usage.payload.info = { last_token_usage: counters, total_token_usage: counters };
      }
      const rows = [{ type: 'session_meta', payload: { id, model_provider: 'openai' } },
        { type: 'turn_context', payload: { turn_id: 'stable', model: 'gpt-5.4' } }, usage];
      if (failure === 'symlink') {
        rows[2].payload.info = { last_token_usage: { input_tokens: 15 }, total_token_usage: { input_tokens: 15 } };
        if (malformed) fs.unlinkSync(target);
        else if (tokens === 45) {
          const linkedRows = structuredClone(rows);
          linkedRows[2].payload.info = { last_token_usage: { input_tokens: 30 }, total_token_usage: { input_tokens: 30 } };
          fs.writeFileSync(target, linkedRows.map(JSON.stringify).join('\n') + '\n');
          fs.symlinkSync(target, link);
        } else fs.unlinkSync(link);
      }
      if (malformed && ['root', 'data', 'result', 'response'].includes(failure)) rows.push(failure === 'root' ? { usage: null } : { [failure]: { usage: null } });
      fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
      fs.utimesSync(file, new Date('2026-10-12T12:00:00Z'), new Date('2026-10-12T12:00:00Z'));
    }
    const options = { clients: 'codex', deviceId: 'native-review', allTimeSince: '2026-01-01',
      homeDir: home, env: { TOKSCALE_CONFIG_DIR: config }, projectsEnabled: false, wslScanEnabled: false,
      codexLocalUsageEnabled: false, includeHistory: true, dailyHistoryArchiveEnabled: true,
      sessionUsageArchive: { version: 1, sessions: {} }, dailyHistoryArchiveOptions: { path: path.join(home, 'daily.json') },
      sessionMetadataDeps: { sessionMetadataResolvers: new Map() },
      runTokscale: async ({ flags }) => run(['--json', '--client', 'codex', '--group-by', 'client,workspace,session,model', ...flags]),
      runGraph: async () => run(['graph', '--client', 'codex', '--source-snapshots']) };
    const subset = ['reasoning-subset', 'cache-subset', 'total-mismatch', 'symlink'].includes(failure);
    const accepted = subset ? 45 : 100;
    write(accepted);
    assert.equal((await collectUsageOnce(options)).allTime.totalTokens, accepted);
    const original = run(['graph', '--client', 'codex', '--source-snapshots']).sourceUsage;
    write(20, true);
    const source = run(['graph', '--client', 'codex', '--source-snapshots']).sourceUsage;
    const partial = ['array', 'timestamp'].includes(failure) || subset;
    if (subset) assert.deepEqual(source.sessions.flatMap(row => row.events.map(event => event.id)), original.sessions.flatMap(row => row.events.map(event => event.id)));
    assert.equal(source.scopes[0].readStatus, partial ? 'partial' : 'complete');
    const corrected = await collectUsageOnce(options);
    assert.equal(corrected.allTime.totalTokens, partial ? accepted : 20);
    assert.equal(corrected.history.summary.totalTokens, partial ? accepted : 20);
    assert.equal(corrected.history.daily.find(value => value.date === '2026-03-02').tokens, partial ? accepted : 20);
    assert.equal(corrected.history.daily.some(value => value.date === '2026-10-12'), false);
    if (subset) {
      write(15);
      const healthy = run(['graph', '--client', 'codex', '--source-snapshots']).sourceUsage;
      assert.equal(healthy.scopes[0].readStatus, 'complete');
      assert.equal(healthy.scopes[0].identityStatus, 'exact');
      assert.deepEqual(healthy.sessions.flatMap(row => row.events.map(event => event.id)), original.sessions.flatMap(row => row.events.map(event => event.id)));
      const correction = await collectUsageOnce(options);
      assert.equal(correction.allTime.totalTokens, 15);
      assert.equal(correction.history.summary.totalTokens, 15);
    }
    const scopes = Object.values(JSON.parse(fs.readFileSync(options.dailyHistoryArchiveOptions.path)).sourceLedger.scopes);
    assert.equal(scopes.length, 1);
    assert.equal(scopes[0].mode, 'ledger');
  });
}
