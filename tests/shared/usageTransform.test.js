'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  USAGE_TRANSFORM_SETTING_KEYS,
  createUsageTransform,
  usageTransformSettings
} = require('../../src/shared/usage/usageTransform');
const { normalizePeriod } = require('../../src/shared/usage');
const { createSessionUsageArchiveStore, readSessionUsageArchiveSnapshot } = require('../../src/shared/usage/sessionUsageArchiveStore');

const AT = '2026-07-09T08:15:00.000Z';

function summary(sessionTokens = 100) {
  const period = () => normalizePeriod({
    totalTokens: sessionTokens,
    clients: { codex: sessionTokens },
    sessions: {
      'codex:c1': { client: 'codex', sessionId: 'c1', totalTokens: sessionTokens, projectLabel: 'app' }
    }
  });
  return { deviceId: 'mac', updatedAt: AT, today: period(), month: period(), allTime: period() };
}

function fakeStore(overrides = {}) {
  const calls = [];
  const archive = { version: 1, sessions: {} };
  return {
    calls,
    read() { calls.push('read'); return archive; },
    refresh() { calls.push('refresh'); return archive; },
    capture(_summary, now) { calls.push(['capture', now.toISOString()]); return { archive }; },
    ...overrides
  };
}

test('an external agent keeps archive loading read-only', () => {
  const store = fakeStore();
  let snapshots = 0;
  const transform = createUsageTransform({
    store,
    isExternalAgentActive: () => true,
    readSnapshot: () => { snapshots += 1; return { version: 1, sessions: {} }; }
  });

  transform.ensureLoaded();

  assert.equal(snapshots, 1);
  assert.deepEqual(store.calls, []);
});

test('without an external agent the archive loads from the store once', () => {
  const store = fakeStore();
  const transform = createUsageTransform({ store });

  transform.ensureLoaded();
  transform.ensureLoaded();

  assert.deepEqual(store.calls, ['read']);
});

test('a collected summary is captured at its own collection time', () => {
  const store = fakeStore();
  const transform = createUsageTransform({ store, getSettings: () => ({}) });

  const visible = transform.transform(summary());

  assert.deepEqual(store.calls, [['capture', AT]]);
  assert.equal(visible.allTime.sessions['codex:c1'].totalTokens, 100);
  assert.equal(transform.getState().lastUpdate.failureCode, null);
});

test('preview metadata projects read-only and never captures or refreshes the archive', () => {
  for (const external of [false, true]) {
    const store = fakeStore();
    const transform = createUsageTransform({ store, isExternalAgentActive: () => external,
      readSnapshot: () => ({ version: 1, sessions: {} }) });
    assert.equal(transform.transform(summary(), 'progress', { preview: true }).today.totalTokens, 100);
    assert.deepEqual(store.calls, []);
    assert.equal(transform.getState().lastUpdate.at, null);
  }
});

test('a preview leaves released JSON migration evidence and SQLite untouched', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-preview-evidence-'));
  const options = { databasePath: path.join(directory, 'archive.sqlite'), path: path.join(directory, 'archive.json') };
  const { captureSessionUsageArchive } = require('../../src/shared/usage/sessionUsageArchive');
  fs.writeFileSync(options.path, JSON.stringify(captureSessionUsageArchive({}, summary(), new Date(AT))));
  const before = fs.readFileSync(options.path);
  const store = createSessionUsageArchiveStore(options);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const transform = createUsageTransform({ store, readSnapshot: () => readSessionUsageArchiveSnapshot(options) });
  const preview = summary(20);
  preview.updatedAt = '2026-07-10T08:15:00.000Z';
  transform.transform(preview, 'progress', { preview: true });
  assert.deepEqual(fs.readFileSync(options.path), before);
  assert.equal(fs.existsSync(options.databasePath), false);
  assert.equal(store.readMigrationEvidence().sessions['codex:c1'].periods.allTime.totalTokens, 100);
});

test('an external agent owns capture, so the transform only refreshes', () => {
  const store = fakeStore();
  const transform = createUsageTransform({ store, getSettings: () => ({}), isExternalAgentActive: () => true });

  transform.transform(summary());

  assert.deepEqual(store.calls, ['refresh']);
});

test('a disabled session archive is neither captured nor read', () => {
  const store = fakeStore();
  const transform = createUsageTransform({ store, getSettings: () => ({ sessionUsageArchiveEnabled: false }) });

  transform.transform(summary());

  assert.deepEqual(store.calls, []);
});

test('disabled archive projection strips local provenance without reading or capturing', () => {
  const store = fakeStore();
  const transform = createUsageTransform({ store, getSettings: () => ({ sessionUsageArchiveEnabled: false }) });
  const raw = summary();
  const sourcePath = path.join(os.tmpdir(), 'private-session.jsonl');
  raw.sessionArchiveSource = { fullScan: true, presentKeys: ['codex:c1'], paths: { 'codex:c1': sourcePath } };
  raw.today.sessions['codex:c1'].sourcePath = sourcePath;
  const before = JSON.stringify(raw);

  const visible = transform.transform(raw);

  assert.equal(visible.sessionArchiveSource, undefined);
  assert.equal(JSON.stringify(visible).includes(sourcePath), false);
  assert.equal(visible.today.totalTokens, 100);
  assert.deepEqual(store.calls, []);
  assert.equal(JSON.stringify(raw), before);
});

test('a real archive store accepts final whole-ID correction after a preview at the same collection time', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-transform-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const options = { databasePath: path.join(directory, 'archive.sqlite'), path: path.join(directory, 'archive.json') };
  const store = createSessionUsageArchiveStore(options);
  t.after(() => store.close());
  const transform = createUsageTransform({ store });
  const initial = summary();
  initial.updatedAt = new Date(Date.parse(AT) - 60_000).toISOString();
  initial.sessionArchiveSource = { fullScan: true, presentKeys: ['codex:c1'] };
  transform.transform(initial);

  const preview = {
    updatedAt: AT,
    today: summary(80).today,
    sessionArchiveSource: { fullScan: true, presentKeys: ['codex:c1'] }
  };
  assert.equal(transform.transform(preview).today.totalTokens, 80);
  const final = summary(15);
  final.today = normalizePeriod({});
  final.month = normalizePeriod({});
  final.sessionArchiveSource = { fullScan: true, presentKeys: ['codex:c1'] };
  const visible = transform.transform(final);
  assert.equal(visible.today.totalTokens, 0);
  assert.equal(visible.month.totalTokens, 0);
  assert.equal(visible.allTime.totalTokens, 15);

  const zero = summary(0);
  zero.today = normalizePeriod({});
  zero.month = normalizePeriod({});
  zero.allTime = normalizePeriod({});
  zero.sessionArchiveSource = { fullScan: true, presentKeys: ['codex:c1'] };
  transform.transform({ ...preview, updatedAt: new Date(Date.parse(AT) + 60_000).toISOString() });
  zero.updatedAt = new Date(Date.parse(AT) + 60_000).toISOString();
  const cleared = transform.transform(zero);
  for (const name of ['today', 'month', 'allTime']) assert.equal(cleared[name].totalTokens, 0);
  store.close();
  const retained = readSessionUsageArchiveSnapshot(options).sessions['codex:c1'];
  assert.equal(retained.periods.today, undefined);
  assert.equal(retained.periods.month, undefined);
  assert.equal(retained.periods.allTime.totalTokens, 0);
  assert.equal(retained.periodWindows.today.capturedAt, zero.updatedAt);
});

test('a failed capture is reported and falls back to the loaded archive', () => {
  const failures = [];
  const logs = [];
  const store = fakeStore({
    capture() { throw new Error('disk full'); }
  });
  const transform = createUsageTransform({
    store,
    getSettings: () => ({}),
    onCaptureFailure: (error) => failures.push(error.message),
    log: (message) => logs.push(message)
  });

  const visible = transform.transform(summary());

  assert.deepEqual(failures, ['disk full']);
  assert.deepEqual(logs, ['[session-archive] write failed: disk full']);
  assert.equal(transform.getState().lastUpdate.failureCode, 'archive-write-failed');
  assert.deepEqual(store.calls, ['read']);
  assert.equal(visible.allTime.sessions['codex:c1'].totalTokens, 100);
});

test('settings are read when a summary is transformed, not when the transform is created', () => {
  const store = fakeStore();
  let settings = { sessionUsageArchiveEnabled: false };
  const transform = createUsageTransform({ store, getSettings: () => settings });

  const before = transform.transform(summary());
  settings = {
    archivedClientUsage: {
      version: 1,
      clients: {
        claude: {
          capturedAt: AT,
          day: '2026-07-09',
          month: '2026-07',
          periods: { allTime: { totalTokens: 40, clients: { claude: 40 } } }
        }
      }
    },
    clients: 'codex'
  };
  const after = transform.transform(summary());

  assert.equal(before.allTime.clients.claude, undefined);
  assert.equal(after.allTime.clients.claude, 40);
  assert.deepEqual(store.calls, [['capture', AT]]);
});

test('forget and reset decide what the next use sees', () => {
  const store = fakeStore();
  const transform = createUsageTransform({ store });

  assert.deepEqual(transform.getState(), {
    loaded: false,
    sessionCount: null,
    lastUpdate: { at: null, durationMs: null, failureCode: null }
  });
  transform.reset();
  assert.equal(transform.getState().loaded, true);
  assert.equal(transform.getState().sessionCount, 0);
  transform.forget();
  assert.equal(transform.getState().loaded, false);
  transform.ensureLoaded();
  assert.deepEqual(store.calls, ['read']);
});

test('the transform reads no setting outside the ones a worker is handed', () => {
  const read = new Set();
  const settings = new Proxy({ projectsEnabled: true }, {
    get(target, key) {
      if (typeof key === 'string') read.add(key);
      return target[key];
    }
  });
  const transform = createUsageTransform({ store: fakeStore(), getSettings: () => settings });

  transform.transform(summary());
  transform.project(summary(), null, new Date(AT));

  assert.deepEqual([...read].filter((key) => !USAGE_TRANSFORM_SETTING_KEYS.includes(key)), []);
  assert.deepEqual(
    usageTransformSettings({ clients: 'codex', projectsEnabled: false, hubUrl: 'https://hub', secret: 'x' }),
    { clients: 'codex', projectsEnabled: false }
  );
});
