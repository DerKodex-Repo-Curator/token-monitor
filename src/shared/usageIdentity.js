'use strict';

const { canonicalProjectKey } = require('./projectKey');

// Evidence is additive to the existing device contract. A missing, malformed or
// oversized claim never authorizes a deduction from accepted usage.
const PERIODS = ['today', 'month', 'allTime'];
const MAX_EVENTS = 20000;
const ID = /^sha256:[a-f0-9]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const PERIOD_COUNTERS = ['totalTokens', 'costUsd', 'unpricedTokens', 'cacheReadTokens', 'cacheWriteTokens',
  'outputTokens', 'unclassifiedTokens', 'timedTokens', 'timedOutputTokens', 'timedDurationMs'];
const PERIOD_MAPS = ['clients', 'clientCosts', 'clientCacheReads', 'clientCacheWrites', 'clientOutputs',
  'clientUnclassifiedTokens', 'clientUnpricedTokens', 'models', 'modelCosts', 'modelCacheReads',
  'modelCacheWrites', 'modelOutputs', 'modelUnclassifiedTokens', 'modelUnpricedTokens'];
const NESTED_MAPS = ['clientModels', 'clientModelCosts', 'clientModelUnpricedTokens'];
const SESSION_COUNTERS = ['totalTokens', 'costUsd', 'unpricedTokens', 'messageCount', 'inputTokens',
  'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'timedOutputTokens', 'timedDurationMs'];
const HISTORY_COUNTERS = ['tokens', 'cost', 'unpricedTokens', 'messages', 'cacheReadTokens',
  'cacheWriteTokens', 'outputTokens', 'unclassifiedTokens'];
const MAX_PATHS = 8192;
const MAX_EVENT_COUNTERS = 512;

// Dictionary tables keep this optional JSON field inside the existing upload
// budget without compressing or replacing the ordinary usage contract. Decode
// first, then apply exactly the same whitelist and accounting bounds as JSON
// object claims. Paths are data, never executable property expressions.
function packUsageIdentity(identity) {
  const paths = [];
  const pathIndices = new Map();
  const events = [];
  const eventIndices = new Map();
  const coreIndices = new Map();
  const flatten = (value, prefix = [], result = []) => {
    for (const [key, entry] of Object.entries(value || {})) {
      const path = [...prefix, key];
      if (typeof entry !== 'number') {
        if (entry && typeof entry === 'object') flatten(entry, path, result);
        continue;
      }
      if (!entry) continue;
      const signature = JSON.stringify(path);
      if (!pathIndices.has(signature)) { pathIndices.set(signature, paths.length); paths.push(path); }
      result.push(pathIndices.get(signature), entry);
    }
    return result;
  };
  const add = (event, omitSessionDetail = false) => {
    const core = event.usage ? JSON.stringify([event.id, event.observationKind,
      { ...event.usage, sessions: undefined }]) : '';
    // A shared Today/Month event already exposes its admitted session detail.
    // Reuse its counters for AllTime, whose reference explicitly removes that
    // detail. Events found only in AllTime never add a session id to the table.
    if (omitSessionDetail && coreIndices.has(core)) return coreIndices.get(core);
    const row = [event.id, event.observationKind === 'native' ? 1 : 0, event.sessionId || '',
      event.usage ? flatten(event.usage) : event.days.map(day => [day.date, flatten(day.usage)])];
    const signature = JSON.stringify(row);
    if (!eventIndices.has(signature)) { eventIndices.set(signature, events.length); events.push(row); }
    const index = eventIndices.get(signature);
    if (core) coreIndices.set(core, index);
    return index;
  };
  const result = { version: 1, eventIdentityVersion: 2, encoding: 'counter-table-v1', paths, events, periods: {} };
  for (const [name, evidence] of Object.entries(identity.periods || {})) {
    result.periods[name] = { capturedAt: evidence.capturedAt, events: evidence.events.map(event => add(event, name === 'allTime')),
      ...(name === 'allTime' ? { omitSessionDetail: true } : {}) };
  }
  if (identity.history) result.history = { capturedAt: identity.history.capturedAt, events: identity.history.events.map(event => add(event)) };
  return paths.length <= MAX_PATHS && events.every(row => Array.isArray(row[3][0])
    ? row[3].every(day => day[1].length <= MAX_EVENT_COUNTERS * 2) : row[3].length <= MAX_EVENT_COUNTERS * 2) ? result : null;
}

function unpackUsageIdentity(raw) {
  if (raw.encoding !== 'counter-table-v1' || !Array.isArray(raw.paths) || raw.paths.length > MAX_PATHS
    || !Array.isArray(raw.events) || raw.events.length > MAX_EVENTS) return null;
  const paths = raw.paths;
  if (paths.some(path => !Array.isArray(path) || !path.length || path.length > 5
    || path.some(key => typeof key !== 'string' || !key || key.length > 512 || ['__proto__', 'constructor', 'prototype'].includes(key)))) return null;
  const inflate = pairs => {
    if (!Array.isArray(pairs) || pairs.length % 2 || pairs.length > MAX_EVENT_COUNTERS * 2) throw new Error('invalid table row');
    const result = Object.create(null);
    for (let index = 0; index < pairs.length; index += 2) {
      const path = paths[pairs[index]];
      if (!Number.isSafeInteger(pairs[index]) || !path || typeof pairs[index + 1] !== 'number' || !Number.isFinite(pairs[index + 1])) throw new Error('invalid table counter');
      let target = result;
      for (const key of path.slice(0, -1)) {
        if (own(target, key) && (!target[key] || typeof target[key] !== 'object')) throw new Error('overlapping paths');
        target = target[key] ||= Object.create(null);
      }
      const key = path[path.length - 1];
      if (own(target, key)) throw new Error('duplicate table counter');
      target[key] = pairs[index + 1];
    }
    return result;
  };
  let count = 0;
  const evidence = (value, history = false, omitSessionDetail = false) => {
    if (!value || !Array.isArray(value.events) || value.events.length > MAX_EVENTS) return null;
    count += value.events.length;
    if (count > MAX_EVENTS) throw new Error('too many claims');
    return { capturedAt: value.capturedAt, events: value.events.map(index => {
      const row = raw.events[index];
      if (!Number.isSafeInteger(index) || !Array.isArray(row) || row.length !== 4 || ![0, 1].includes(row[1])) throw new Error('invalid event reference');
      const event = { id: row[0], observationKind: row[1] ? 'native' : 'mirror', sessionId: row[2] };
      if (!history) {
        event.usage = inflate(row[3]);
        if (omitSessionDetail) { delete event.sessionId; delete event.usage.sessions; }
      }
      else {
        if (!Array.isArray(row[3]) || row[3].length > 64) throw new Error('invalid history claim');
        event.days = row[3].map(day => {
          if (!Array.isArray(day) || day.length !== 2) throw new Error('invalid history day');
          return { date: day[0], usage: inflate(day[1]) };
        });
      }
      return event;
    }) };
  };
  try {
    return { version: 1, eventIdentityVersion: 2,
      periods: Object.fromEntries(PERIODS.filter(name => own(raw.periods, name)).map(name => [name,
        evidence(raw.periods[name], false, name === 'allTime' && raw.periods[name]?.omitSessionDetail === true)])),
      ...(raw.history ? { history: evidence(raw.history, true) } : {}) };
  } catch { return null; }
}

function numeric(value, key) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('invalid counter');
  if (!/cost/i.test(key) && !Number.isSafeInteger(value)) throw new Error('invalid integer counter');
  return value;
}

function counters(value, fields) {
  const result = Object.create(null);
  for (const key of fields) if (own(value, key)) {
    const count = numeric(value[key], key);
    if (count) result[key] = count;
  }
  return result;
}

function map(value, fields, counterName = '') {
  const result = Object.create(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, entry] of Object.entries(value)) {
    if (!key || key.length > 512 || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('invalid map key');
    const next = fields ? counters(entry, fields) : numeric(entry, counterName || key);
    if (typeof next === 'number' ? next > 0 : Object.keys(next).length > 0) result[key] = next;
  }
  return result;
}

function periodCounters(value) {
  const result = counters(value, PERIOD_COUNTERS);
  for (const key of PERIOD_MAPS) result[key] = map(value?.[key], null, key);
  for (const key of NESTED_MAPS) {
    result[key] = Object.create(null);
    for (const [client, models] of Object.entries(value?.[key] || {})) {
      // Counters from non-claiming clients are read only when bounding a claim.
      if (['__proto__', 'constructor', 'prototype'].includes(client)) throw new Error('invalid client');
      result[key][client] = map(models, null, key);
    }
  }
  if (value?.modelThroughput) result.modelThroughput = map(value.modelThroughput, ['timedTokens', 'timedOutputTokens', 'timedDurationMs']);
  result.sessions = map(value?.sessions, SESSION_COUNTERS);
  for (const [key, session] of Object.entries(result.sessions)) {
    session.models = map(value.sessions[key]?.models, null, 'tokens');
    session.modelCosts = map(value.sessions[key]?.modelCosts, null, 'cost');
    session.providers = map(value.sessions[key]?.providers, null, 'tokens');
  }
  result.projects = map(value?.projects, ['tokens', 'costUsd', 'unpricedTokens']);
  for (const [key, project] of Object.entries(result.projects)) project.clients = map(value.projects[key]?.clients, null, 'tokens');
  return result;
}

function historyCounters(value) {
  const result = counters(value, HISTORY_COUNTERS);
  result.perClient = map(value?.perClient, HISTORY_COUNTERS);
  result.perModel = map(value?.perModel, HISTORY_COUNTERS);
  return result;
}

function monthlyCounters(value) {
  const result = historyCounters(value);
  for (const key of HISTORY_COUNTERS) if (!['tokens', 'cost', 'unpricedTokens'].includes(key)) delete result[key];
  for (const row of Object.values(result.perClient)) {
    for (const key of Object.keys(row)) if (!['tokens', 'cost', 'unpricedTokens', 'messages'].includes(key)) delete row[key];
  }
  for (const row of Object.values(result.perModel)) {
    for (const key of Object.keys(row)) if (!['tokens', 'cost', 'unpricedTokens'].includes(key)) delete row[key];
  }
  return result;
}

function availableHistoryComponents(usage, accepted) {
  const fields = ['cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'unclassifiedTokens'];
  for (const field of fields) if (!own(accepted, field)) delete usage[field];
  for (const group of ['perClient', 'perModel']) {
    for (const [key, row] of Object.entries(usage[group])) {
      for (const field of fields) if (!own(accepted?.[group]?.[key], field)) delete row[field];
    }
  }
}

function addTree(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number') target[key] = (target[key] || 0) + value;
    else addTree(target[key] ||= Object.create(null), value);
  }
  return target;
}

function within(claim, accepted, cost = false) {
  return Object.entries(claim).every(([key, value]) => {
    const money = cost || /cost/i.test(key);
    const bound = accepted?.[key] || 0;
    return typeof value === 'number'
      ? value <= bound + (money ? 8 * Number.EPSILON * MAX_EVENTS * Math.max(value, bound) : 0)
      : within(value, bound, money);
  });
}

function copy(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(copy);
  const result = Object.create(null);
  for (const [key, entry] of Object.entries(value)) result[key] = copy(entry);
  return result;
}

function deduct(target, claim) {
  for (const [key, value] of Object.entries(claim)) {
    if (typeof value === 'number') {
      if (own(target, key)) target[key] = Math.max(0, target[key] - value);
    } else if (target?.[key] && typeof target[key] === 'object') deduct(target[key], value);
  }
}

function pruneEmptyAttribution(period) {
  for (const field of PERIOD_MAPS) {
    for (const key of Object.keys(period[field] || {})) if (period[field][key] === 0) delete period[field][key];
  }
  for (const field of NESTED_MAPS) {
    for (const [key, models] of Object.entries(period[field] || {})) {
      for (const model of Object.keys(models)) if (models[model] === 0) delete models[model];
      if (!Object.keys(models).length) delete period[field][key];
    }
  }
  for (const [key, row] of Object.entries(period.projects || {})) {
    if (!row.tokens && !row.costUsd && !row.unpricedTokens) delete period.projects[key];
  }
  for (const [key, row] of Object.entries(period.sessions || {})) {
    if (!row.totalTokens && !row.costUsd && !row.unpricedTokens && !row.messageCount) delete period.sessions[key];
  }
  for (const [key, row] of Object.entries(period.modelThroughput || {})) {
    if (!row.timedTokens && !row.timedOutputTokens && !row.timedDurationMs) delete period.modelThroughput[key];
  }
}

function total(mapValue) { return Object.values(mapValue || {}).reduce((sum, n) => sum + n, 0); }
function equal(a, b) {
  if (Number.isSafeInteger(a || 0) && Number.isSafeInteger(b || 0)) return (a || 0) === (b || 0);
  return a === b || Math.abs((a || 0) - (b || 0)) <= 8 * Number.EPSILON * MAX_EVENTS * Math.max(a || 0, b || 0);
}

function sameCounters(left, right) {
  return [...new Set([...Object.keys(left || {}), ...Object.keys(right || {})])]
    .every(key => equal(left?.[key], right?.[key]));
}

function normalizedPeriodClaim(raw, accepted) {
  const claim = periodCounters(raw);
  if (!equal(claim.totalTokens, claim.clients.claude) || !equal(claim.costUsd, claim.clientCosts.claude)
    || Object.keys(claim.clients).some(key => key !== 'claude')
    || Object.keys(claim.clientCosts).some(key => key !== 'claude')
    || !equal(claim.totalTokens, total(claim.models)) || !equal(claim.costUsd, total(claim.modelCosts))
    || !equal(claim.totalTokens, total(claim.clientModels.claude))
    || !equal(claim.costUsd, total(claim.clientModelCosts.claude))) return null;
  if (!sameCounters(claim.models, claim.clientModels.claude)
    || !sameCounters(claim.modelCosts, claim.clientModelCosts.claude)
    || !sameCounters(claim.modelUnpricedTokens, claim.clientModelUnpricedTokens.claude)) return null;
  for (const field of [...PERIOD_MAPS.filter(key => key.startsWith('client')), ...NESTED_MAPS]) {
    if (Object.keys(claim[field]).some(key => key !== 'claude')) return null;
  }
  for (const [scalar, clients, models] of [
    ['cacheReadTokens', 'clientCacheReads', 'modelCacheReads'],
    ['cacheWriteTokens', 'clientCacheWrites', 'modelCacheWrites'],
    ['outputTokens', 'clientOutputs', 'modelOutputs'],
    ['unclassifiedTokens', 'clientUnclassifiedTokens', 'modelUnclassifiedTokens'],
    ['unpricedTokens', 'clientUnpricedTokens', 'modelUnpricedTokens']
  ]) {
    if (!equal(claim[scalar], claim[clients].claude) || !equal(claim[scalar], total(claim[models]))
      || (claim[scalar] || 0) > (claim.totalTokens || 0) || !within(claim[models], claim.models)) return null;
  }
  if (!equal(claim.unpricedTokens, total(claim.clientModelUnpricedTokens.claude))
    || !within(claim.clientModelUnpricedTokens.claude || {}, claim.models)
    || (claim.timedTokens || 0) > (claim.totalTokens || 0)
    || (claim.timedOutputTokens || 0) > (claim.outputTokens || 0)
    || ['cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'unclassifiedTokens']
      .reduce((sum, field) => sum + (claim[field] || 0), 0) > (claim.totalTokens || 0)) return null;
  for (const [model, row] of Object.entries(claim.modelThroughput || {})) {
    if ((row.timedTokens || 0) > (claim.models[model] || 0)
      || (row.timedOutputTokens || 0) > (claim.modelOutputs[model] || 0)) return null;
  }
  for (const [model, tokens] of Object.entries(claim.models)) {
    if (['modelCacheReads', 'modelCacheWrites', 'modelOutputs', 'modelUnclassifiedTokens']
      .reduce((sum, field) => sum + (claim[field][model] || 0), 0) > tokens) return null;
  }
  for (const field of ['timedTokens', 'timedOutputTokens', 'timedDurationMs']) {
    if (!equal(claim[field], Object.values(claim.modelThroughput || {}).reduce((sum, row) => sum + (row[field] || 0), 0))) return null;
  }
  for (const [key, session] of Object.entries(claim.sessions)) {
    if (!key.startsWith('claude:') || !equal(session.totalTokens, total(session.models))
      || !equal(session.costUsd, total(session.modelCosts))
      || !within(session.models, claim.models) || !within(session.modelCosts, claim.modelCosts, true)
      || Object.keys(session.providers).length > 0 && !equal(session.totalTokens, total(session.providers))) return null;
  }
  for (const project of Object.values(claim.projects)) {
    if (Object.keys(project.clients).some(client => client !== 'claude')
      || !equal(project.tokens, project.clients.claude)) return null;
  }
  for (const [table, fields] of [['sessions', SESSION_COUNTERS], ['projects', ['tokens', 'costUsd', 'unpricedTokens']]]) {
    for (const field of fields.filter(key => !['messageCount', 'inputTokens', 'reasoningTokens'].includes(key))) {
      const count = Object.values(claim[table]).reduce((sum, row) => sum + (row[field] || 0), 0);
      const bound = claim[field === 'tokens' ? 'totalTokens' : field] || 0;
      if (count > bound && !equal(count, bound)) return null;
    }
  }
  // Session/project detail can be deliberately omitted from a bounded upload.
  // Deduct only rows still represented in the accepted record, never synthesize them.
  for (const field of ['sessions', 'projects']) {
    for (const key of Object.keys(claim[field])) if (!own(accepted?.[field], key)) delete claim[field][key];
  }
  if (!accepted?.modelThroughput) delete claim.modelThroughput;
  return claim;
}

function eventHeader(event) {
  if (!ID.test(event?.id) || !['native', 'mirror'].includes(event.observationKind)) return null;
  return { id: event.id, observationKind: event.observationKind,
    ...(typeof event.sessionId === 'string' && event.sessionId.length <= 256 ? { sessionId: event.sessionId } : {}) };
}

function normalizePeriodEvidence(raw, accepted) {
  if (!raw || !Number.isFinite(Date.parse(raw.capturedAt)) || !Array.isArray(raw.events) || raw.events.length > MAX_EVENTS) return null;
  const ids = new Set();
  const events = [];
  const sum = Object.create(null);
  for (const event of raw.events) {
    const header = eventHeader(event);
    const usage = normalizedPeriodClaim(event?.usage, accepted);
    if (!header || !usage || ids.has(header.id)) return null;
    const sessionKey = `claude:${header.sessionId || ''}`;
    if (Object.keys(event.usage?.sessions || {}).some(key => key !== sessionKey)) return null;
    const project = canonicalProjectKey(accepted?.sessions?.[sessionKey]?.projectLabel);
    if (project && Object.keys(usage.projects).some(key => key !== project)) return null;
    if (accepted?.sessions?.[sessionKey] && !project && Object.keys(usage.projects).length) return null;
    ids.add(header.id);
    addTree(sum, usage);
    events.push({ ...header, usage });
  }
  if (!within(sum, periodCounters(accepted))) return null;
  return { capturedAt: new Date(raw.capturedAt).toISOString(), events };
}

function normalizeHistoryEvidence(raw, accepted) {
  if (!accepted || !raw || !Number.isFinite(Date.parse(raw.capturedAt)) || !Array.isArray(raw.events) || raw.events.length > MAX_EVENTS) return null;
  const daily = new Map((accepted.daily || []).map(day => [day.date, day]));
  const monthly = new Map((accepted.monthly || []).map(month => [month.month, month]));
  const ids = new Set();
  const events = [];
  const days = new Map();
  const months = new Map();
  for (const event of raw.events) {
    const header = eventHeader(event);
    if (!header || ids.has(header.id) || !Array.isArray(event.days) || event.days.length > 64) return null;
    ids.add(header.id);
    const rows = [];
    const eventDays = new Set();
    for (const day of event.days) {
      if (!DAY.test(day?.date) || eventDays.has(day.date)) return null;
      eventDays.add(day.date);
      const usage = historyCounters(day.usage);
      if (!equal(usage.tokens, usage.perClient.claude?.tokens) || !equal(usage.cost, usage.perClient.claude?.cost)
        || Object.keys(usage.perClient).some(key => key !== 'claude')
        || !equal(usage.tokens, Object.values(usage.perModel).reduce((sum, v) => sum + (v.tokens || 0), 0))
        || !equal(usage.cost, Object.values(usage.perModel).reduce((sum, v) => sum + (v.cost || 0), 0))) return null;
      for (const field of HISTORY_COUNTERS.filter(key => !['tokens', 'cost'].includes(key))) {
        if (!equal(usage[field], usage.perClient.claude?.[field])
          || field !== 'messages' && !equal(usage[field], Object.values(usage.perModel).reduce((sum, row) => sum + (row[field] || 0), 0))
          || field !== 'messages' && (usage[field] || 0) > (usage.tokens || 0)) return null;
      }
      if (['cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'unclassifiedTokens']
        .reduce((sum, field) => sum + (usage[field] || 0), 0) > (usage.tokens || 0)) return null;
      for (const row of Object.values(usage.perModel)) {
        if (['cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'unclassifiedTokens']
          .reduce((sum, field) => sum + (row[field] || 0), 0) > (row.tokens || 0)) return null;
      }
      if (daily.has(day.date)) availableHistoryComponents(usage, daily.get(day.date));
      if (daily.has(day.date)) addTree(days.get(day.date) || (days.set(day.date, Object.create(null)), days.get(day.date)), usage);
      const month = day.date.slice(0, 7);
      addTree(months.get(month) || (months.set(month, Object.create(null)), months.get(month)), monthlyCounters(usage));
      rows.push({ date: day.date, usage });
    }
    events.push({ ...header, days: rows });
  }
  for (const [date, sum] of days) if (!within(sum, historyCounters(daily.get(date)))) return null;
  for (const [month, sum] of months) {
    if (!within(sum, monthlyCounters(monthly.get(month)))) return null;
  }
  return { capturedAt: new Date(raw.capturedAt).toISOString(), events };
}

function normalizeUsageIdentity(raw, record) {
  if (raw?.version !== 1 || raw.eventIdentityVersion !== 2) return null;
  if (raw.encoding) {
    raw = unpackUsageIdentity(raw);
    if (!raw) return null;
  }
  try {
    const result = { version: 1, eventIdentityVersion: 2, periods: {} };
    for (const name of PERIODS) {
      const evidence = normalizePeriodEvidence(raw.periods?.[name], record.periods?.[name] || record[name]);
      if (evidence) result.periods[name] = evidence;
    }
    const history = normalizeHistoryEvidence(raw.history, record.history);
    if (history) result.history = history;
    const count = Object.values(result.periods).reduce((n, evidence) => n + evidence.events.length, history?.events.length || 0);
    return count <= MAX_EVENTS && (Object.keys(result.periods).length || history) ? result : null;
  } catch { return null; }
}

function preferred(a, b) {
  const nativeA = a.event.observationKind === 'native';
  const nativeB = b.event.observationKind === 'native';
  if (nativeA !== nativeB) return nativeA ? a : b;
  if (a.capturedAt !== b.capturedAt) return a.capturedAt > b.capturedAt ? a : b;
  return a.deviceId.localeCompare(b.deviceId) <= 0 ? a : b;
}

function losers(records, evidenceFor, eligible = () => true) {
  const byId = new Map();
  records.forEach((record, index) => {
    if (!eligible(record)) return;
    const evidence = evidenceFor(record);
    for (const event of evidence?.events || []) {
      const claim = { index, event, capturedAt: evidence.capturedAt, deviceId: record.deviceId || String(index) };
      const group = byId.get(event.id) || [];
      group.push(claim); byId.set(event.id, group);
    }
  });
  const result = [];
  for (const group of byId.values()) {
    if (group.length < 2) continue;
    const winner = group.reduce(preferred);
    for (const claim of group) if (claim !== winner) result.push(claim);
  }
  return result;
}

function reconcilePeriodIdentities(records, name, eligible) {
  const result = records.map(record => record.periods[name]);
  const changed = new Set();
  for (const loser of losers(records, record => record.usageIdentity?.periods?.[name], eligible)) {
    if (!changed.has(loser.index)) { result[loser.index] = copy(result[loser.index]); changed.add(loser.index); }
    deduct(result[loser.index], loser.event.usage);
  }
  for (const index of changed) pruneEmptyAttribution(result[index]);
  return result;
}

function reconcileHistoryIdentities(records) {
  const result = records.map(record => record.history);
  const changed = new Set();
  for (const loser of losers(records, record => record.usageIdentity?.history)) {
    if (!changed.has(loser.index)) { result[loser.index] = copy(result[loser.index]); changed.add(loser.index); }
    const history = result[loser.index];
    for (const { date, usage } of loser.event.days) {
      const day = history?.daily?.find(row => row.date === date);
      if (day) deduct(day, usage);
      const month = history?.monthly?.find(row => row.month === date.slice(0, 7));
      if (month) deduct(month, usage);
    }
  }
  return result;
}

module.exports = { packUsageIdentity, normalizeUsageIdentity, reconcilePeriodIdentities, reconcileHistoryIdentities };
