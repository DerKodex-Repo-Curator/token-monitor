'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { PERIODS, normalizePeriod, normalizeClientName } = require('../usage');
const {
  cloneJson,
  hasSummaryPeriod,
  localDay,
  localMonth,
  numberValue,
  periodFor,
  targetPeriod,
  toDate
} = require('../archiveHelpers');
const { readJson, sharedDataDir, writeJsonAtomic } = require('../config');
const { filterReasonixSyntheticSessions, isReasonixSyntheticSession } = require('../providers/reasonix/sessionGuard');
const { splitClientIdFor } = require('../clientIdentitySplits');
const { classifySessionSourcePath, ownedSessionSourcePath } = require('./sessionSourceState');
const {
  isLegacyCursorEntry,
  legacyCursorLookup,
  supersedingCursorSessionId
} = require('../providers/cursor/sessionGuard');

function sessionUsageArchiveDate(deviceRecord, fallback = new Date()) {
  const collectedAt = new Date(deviceRecord?.updatedAt || '');
  return Number.isNaN(collectedAt.getTime()) ? toDate(fallback) : collectedAt;
}

// A capture asks for the key of every session in the tick, and building it
// means normalizing a one-session period. The answer depends on nothing but the
// two strings, so it is kept; the bound only matters to a process that runs for
// months without restarting.
const SESSION_KEY_CACHE_LIMIT = 50000;
const sessionKeyCache = new Map();

function sessionKey(client, sessionId) {
  if (typeof client !== 'string' || typeof sessionId !== 'string') return computeSessionKey(client, sessionId);
  const cacheKey = `${client}\u0000${sessionId}`;
  if (sessionKeyCache.has(cacheKey)) return sessionKeyCache.get(cacheKey);
  const key = computeSessionKey(client, sessionId);
  if (sessionKeyCache.size >= SESSION_KEY_CACHE_LIMIT) sessionKeyCache.clear();
  sessionKeyCache.set(cacheKey, key);
  return key;
}

function computeSessionKey(client, sessionId) {
  const normalized = normalizePeriod({
    sessions: {
      candidate: { client, sessionId, totalTokens: 1 }
    }
  });
  const session = Object.values(normalized.sessions)[0];
  return session ? `${session.client}:${session.sessionId}` : null;
}

function sameJson(left, right) {
  return isDeepStrictEqual(left || null, right || null);
}

function normalizedSessionFrom(value, fallbackKey) {
  if (isReasonixSyntheticSession(value, fallbackKey)) return null;
  const period = normalizePeriod({ sessions: { [fallbackKey || 'session']: value } });
  return Object.values(period.sessions)[0] || null;
}

function hasSessionUsage(session) {
  return numberValue(session?.totalTokens) > 0 || numberValue(session?.costUsd) > 0;
}

// Migration authority needs intact retained evidence, not the best-effort
// normalization used for ordinary archive display. Reject the whole snapshot
// if a row could otherwise be silently dropped or lose accounting.
function evidenceRecord(candidate) {
  return candidate && typeof candidate === 'object'
    && [null, Object.prototype].includes(Object.getPrototypeOf(candidate));
}

function isSessionUsageArchiveEntryEvidence(key, entry) {
  const counter = candidate => typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0;
  if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) || key.includes('\0')
    || !evidenceRecord(entry) || typeof entry.client !== 'string' || !entry.client.trim()
    || normalizeClientName(entry.client) !== entry.client || typeof entry.sessionId !== 'string' || !entry.sessionId.trim()
    || key !== `${entry.client}:${entry.sessionId}` || !evidenceRecord(entry.periods)) return false;
  const names = Object.keys(entry.periods);
  if (!names.length || names.some(name => !PERIODS.includes(name))) return false;
  return names.every(name => {
    const row = entry.periods[name];
    if (!evidenceRecord(row) || row.client !== entry.client || row.sessionId !== entry.sessionId
      || !counter(row.totalTokens) || !counter(row.costUsd)) return false;
    for (const field of ['outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'unclassifiedTokens']) {
      if (row[field] !== undefined && !counter(row[field])) return false;
    }
    for (const field of ['models', 'modelCosts']) {
      if (row[field] !== undefined && (!evidenceRecord(row[field]) || !Object.values(row[field]).every(counter))) return false;
    }
    return true;
  });
}

function isSessionUsageArchiveEvidence(value) {
  if (!evidenceRecord(value) || value.version !== 1 || !evidenceRecord(value.sessions)) return false;
  return Reflect.ownKeys(value.sessions).every(key => Object.prototype.propertyIsEnumerable.call(value.sessions, key)
    && isSessionUsageArchiveEntryEvidence(key, value.sessions[key]));
}

function normalizeSessionUsageArchive(value) {
  const source = value?.sessions && typeof value.sessions === 'object' ? value.sessions : value;
  const normalized = { version: 1, sessions: {} };
  if (!source || typeof source !== 'object') return normalized;

  for (const [rawKey, rawEntry] of Object.entries(source)) {
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    if (isReasonixSyntheticSession(rawEntry, rawKey)) continue;
    const rawPeriods = rawEntry.periods && typeof rawEntry.periods === 'object'
      ? rawEntry.periods
      : rawEntry;
    const entry = {
      client: '',
      sessionId: '',
      capturedAt: toDate(rawEntry.capturedAt).toISOString(),
      day: String(rawEntry.day || localDay(rawEntry.capturedAt)),
      month: String(rawEntry.month || localMonth(rawEntry.capturedAt)),
      periodWindows: {},
      periods: {}
    };

    for (const periodName of PERIODS) {
      const session = normalizedSessionFrom(rawPeriods?.[periodName], rawKey);
      if (!session || isReasonixSyntheticSession(session, rawKey)) continue;
      delete session.liveActivity;
      delete session.waitingForInput;
      const key = sessionKey(session.client, session.sessionId);
      if (!key) continue;
      entry.client = session.client;
      entry.sessionId = session.sessionId;
      entry.periods[periodName] = session;
      const rawWindow = rawEntry.periodWindows?.[periodName] || {};
      entry.periodWindows[periodName] = {
        capturedAt: toDate(rawWindow.capturedAt || rawEntry.capturedAt).toISOString()
      };
      if (periodName === 'today') entry.periodWindows[periodName].day = String(rawWindow.day || rawEntry.day || localDay(rawEntry.capturedAt));
      if (periodName === 'month') entry.periodWindows[periodName].month = String(rawWindow.month || rawEntry.month || localMonth(rawEntry.capturedAt));
    }

    if (!entry.client || !entry.sessionId || Object.keys(entry.periods).length === 0) continue;
    entry.sourceState = ['present', 'missing', 'unknown'].includes(rawEntry.sourceState)
      ? rawEntry.sourceState : 'unknown';
    const sourcePath = ownedSessionSourcePath(rawEntry.sourcePath);
    if (sourcePath) entry.sourcePath = sourcePath;
    else if (entry.sourceState === 'missing') entry.sourceState = 'unknown';
    const observedTime = Date.parse(rawEntry.sourceObservedAt || '');
    if (Number.isFinite(observedTime)) entry.sourceObservedAt = new Date(observedTime).toISOString();
    // An absent period still has a collection frontier after a full-ID clear.
    for (const periodName of PERIODS) {
      const rawWindow = rawEntry.periodWindows?.[periodName];
      if (entry.periodWindows[periodName] || !Number.isFinite(Date.parse(rawWindow?.capturedAt || ''))) continue;
      entry.periodWindows[periodName] = { capturedAt: new Date(rawWindow.capturedAt).toISOString() };
      if (periodName === 'today') entry.periodWindows[periodName].day = String(rawWindow.day || entry.day);
      if (periodName === 'month') entry.periodWindows[periodName].month = String(rawWindow.month || entry.month);
    }
    const supersededBy = sessionKey('cursor', String(rawEntry.supersededBy || '').replace(/^cursor:/, ''));
    if (rawEntry.supersededBy && supersededBy && isLegacyCursorEntry(entry)) entry.supersededBy = supersededBy;
    normalized.sessions[`${entry.client}:${entry.sessionId}`] = entry;
  }

  return normalized;
}

function canonicalSessionUsageArchive(value) {
  if (value?.version === 1 && value.sessions && typeof value.sessions === 'object') return value;
  return normalizeSessionUsageArchive(value);
}

function pruneExpiredSessionUsagePeriods(archive, capturedAt, changedKeys) {
  const day = localDay(capturedAt);
  const month = localMonth(capturedAt);
  // Collector snapshots can finish out of order across processes. A stale
  // snapshot must never move the pruning frontier backwards.
  const pruneDay = !archive.prunedDay || archive.prunedDay < day;
  const pruneMonth = !archive.prunedMonth || archive.prunedMonth < month;
  if (!pruneDay && !pruneMonth) return;

  for (const [key, entry] of Object.entries(archive.sessions)) {
    let changed = false;
    entry.periodWindows = entry.periodWindows || {};
    const todayWindow = entry.periodWindows?.today;
    const retainedDay = todayWindow?.day || entry.day;
    if (pruneDay && entry.periods?.today && (!retainedDay || retainedDay < day)) {
      delete entry.periods.today;
      delete entry.periodWindows.today;
      changed = true;
    }
    const monthWindow = entry.periodWindows?.month;
    const retainedMonth = monthWindow?.month || entry.month;
    if (pruneMonth && entry.periods?.month && (!retainedMonth || retainedMonth < month)) {
      delete entry.periods.month;
      delete entry.periodWindows.month;
      changed = true;
    }
    if (changed) changedKeys.add(key);
  }
  if (pruneDay) archive.prunedDay = day;
  if (pruneMonth) archive.prunedMonth = month;
}

// The caller owns the canonical in-memory archive. Updating it in place keeps a
// watch tick proportional to the sessions in that tick instead of cloning and
// normalizing every retained session. Persistence receives only changed keys.
function updateSessionUsageArchive(existingArchive, deviceRecord, capturedAt = new Date(), options = {}) {
  const archive = canonicalSessionUsageArchive(existingArchive);
  const changedKeys = new Set();
  const captureDate = toDate(capturedAt);
  const captureTime = captureDate.getTime();
  pruneExpiredSessionUsagePeriods(archive, captureDate, changedKeys);
  if (!deviceRecord || typeof deviceRecord !== 'object') return { archive, changedKeys };

  const capturedAtIso = captureDate.toISOString();
  const day = localDay(captureDate);
  const month = localMonth(captureDate);
  const sourceArchivedKeys = new Set(deviceRecord.codexLocalSessionKeys || []);
  const source = deviceRecord.sessionArchiveSource;
  const hasSource = source && typeof source === 'object';
  const managedKeys = new Set(source?.managedKeys || []);
  const checkedClients = new Set((source?.boundaryCheckedClients || []).map(normalizeClientName));
  const ownedClients = new Set((source?.ownedClients || []).map(normalizeClientName).filter(client => checkedClients.has(client)));
  const legacyClients = new Set((source?.legacyClients || []).map(normalizeClientName));
  const scannedPeriods = new Map(PERIODS.map((periodName) => {
    const rawPeriod = deviceRecord?.periods?.[periodName] || deviceRecord?.[periodName];
    return [periodName, options.canonicalSummary === true
      ? (rawPeriod && typeof rawPeriod === 'object' ? rawPeriod : { sessions: {} })
      : periodFor(deviceRecord, periodName)];
  }));
  // A preview cannot turn absence in an unscanned period into a zero reading.
  const fullSourceScan = hasSource && source.fullScan === true && Array.isArray(source.presentKeys)
    && PERIODS.every((name) => hasSummaryPeriod(deviceRecord, name)
      && typeof (deviceRecord.periods?.[name] || deviceRecord[name]) === 'object'
      && (deviceRecord.periods?.[name] || deviceRecord[name]) !== null);
  const fullLiveKeys = new Set();
  if (fullSourceScan) {
    for (const rawKey of source.presentKeys) {
      if (typeof rawKey !== 'string') continue;
      const separator = rawKey.indexOf(':');
      if (separator < 1) continue;
      const key = sessionKey(rawKey.slice(0, separator), rawKey.slice(separator + 1));
      if (key && !sourceArchivedKeys.has(key) && !isReasonixSyntheticSession(null, key)) fullLiveKeys.add(key);
    }
    for (const session of Object.values(scannedPeriods.get('allTime').sessions || {})) {
      const key = sessionKey(session.client, session.sessionId);
      if (key && !sourceArchivedKeys.has(key) && !isReasonixSyntheticSession(session)
        && !session.archived && !session.retained
        && (!session.sourceState || session.sourceState === 'present')) fullLiveKeys.add(key);
    }
    reconcileSessionSources(archive, scannedPeriods, fullLiveKeys, source, sourceArchivedKeys,
      captureDate, changedKeys, options, managedKeys, ownedClients);
  }
  for (const periodName of PERIODS) {
    if (periodName === 'today' && archive.prunedDay && day < archive.prunedDay) continue;
    if (periodName === 'month' && archive.prunedMonth && month < archive.prunedMonth) continue;
    const period = scannedPeriods.get(periodName);
    for (const session of Object.values(period.sessions || {})) {
      if (isReasonixSyntheticSession(session) || session.archived || session.retained
        || (session.sourceState && session.sourceState !== 'present')) continue;
      if (!hasSessionUsage(session) && !(hasSource && periodName === 'today')) continue;
      const archiveKey = sessionKey(session.client, session.sessionId);
      if (!archiveKey) continue;
      if (ownedClients.has(session.client)) {
        // An unresolved legacy boundary is not migration proof. Preserve its
        // original evidence; only a migrated ledger may retire these counters.
        if (!legacyClients.has(session.client)) rememberOwnedSessionMetadata(archive, session, archiveKey, capturedAtIso, day, month, changedKeys);
        continue;
      }
      if (sourceArchivedKeys.has(archiveKey) || fullLiveKeys.has(archiveKey)) continue;
      const entry = archive.sessions[archiveKey] || {
        client: session.client,
        sessionId: session.sessionId,
        capturedAt: capturedAtIso,
        day,
        month,
        periodWindows: {},
        periods: {},
        sourceState: 'unknown'
      };
      if (Date.parse(entry.sourceObservedAt || '') > captureTime) continue;
      if (hasSource && (source.fullScan === true || periodName === 'today')
        && newestSessionObservation(entry) <= captureTime) {
        observeSessionSource(entry, 'present', source.paths?.[archiveKey], capturedAtIso, changedKeys, archiveKey);
      }
      const window = entry.periodWindows?.[periodName] || {};
      const retainedCaptureTime = Date.parse(window.capturedAt || '');
      // SQLite serializes commits, not collection time. Keep the newest event
      // for each period when two collectors finish in the opposite order.
      if (Number.isFinite(retainedCaptureTime) && retainedCaptureTime > captureTime) continue;
      const sameWindow = periodName === 'today'
        ? window.day === day
        : periodName === 'month'
          ? window.month === month
          : true;
      // Every tick carries every session of all three periods, and nearly all of
      // them are unchanged, so compare before copying. A session equal to the
      // stored copy would also be equal after the round-trip; one that differs
      // only in what the round-trip drops is caught by the second comparison.
      if (sameWindow && sameJson(entry.periods[periodName], session)) continue;
      const nextSession = cloneJson(session);
      if (managedKeys.has(archiveKey)) enrichSessionMetadata(nextSession, entry, periodName);
      delete nextSession.liveActivity;
      delete nextSession.waitingForInput;
      delete nextSession.sourcePath;
      if (sameWindow && sameJson(entry.periods[periodName], nextSession)) continue;
      entry.client = session.client;
      entry.sessionId = session.sessionId;
      entry.capturedAt = capturedAtIso;
      entry.day = day;
      entry.month = month;
      entry.periods[periodName] = nextSession;
      entry.periodWindows = entry.periodWindows || {};
      entry.periodWindows[periodName] = { capturedAt: capturedAtIso };
      if (periodName === 'today') entry.periodWindows[periodName].day = day;
      if (periodName === 'month') entry.periodWindows[periodName].month = month;
      archive.sessions[archiveKey] = entry;
      changedKeys.add(archiveKey);
    }
  }

  if (options.cursorUsageEvents) linkLegacyCursorEvents(archive, changedKeys, options.cursorUsageEvents);
  return { archive, changedKeys };
}

// Source-owned counters live only in the ledger. The generic archive can
// still retain descriptive metadata for an omitted ID, represented by zero.
function rememberOwnedSessionMetadata(archive, session, key, capturedAt, day, month, changedKeys) {
  const entry = archive.sessions[key];
  if (newestSessionObservation(entry) > Date.parse(capturedAt)) return;
  const prior = entry?.periods?.allTime;
  const metadata = { client: session.client, sessionId: session.sessionId, totalTokens: 0 };
  for (const field of ['title', 'projectId', 'projectLabel', 'sessionKind', 'nativeSessionId', 't3ThreadId']) {
    if (session[field]) metadata[field] = session[field];
    else if (prior?.[field]) metadata[field] = prior[field];
  }
  // A missing parentClient on a new link means the child's own client.
  // Never combine that link with an older cross-client namespace.
  const relationship = session.parentSessionId ? session : prior;
  if (relationship?.parentSessionId) {
    metadata.parentSessionId = relationship.parentSessionId;
    if (relationship.parentClient) metadata.parentClient = relationship.parentClient;
  }
  const next = normalizedSessionFrom(metadata, key);
  if (entry && sameJson(prior, next)) return;
  archive.sessions[key] = { client: session.client, sessionId: session.sessionId, capturedAt, day, month,
    periodWindows: { allTime: { capturedAt } }, periods: { allTime: next }, sourceState: 'unknown' };
  changedKeys.add(key);
}

function observeSessionSource(entry, state, sourcePath, observedAt, changedKeys, key) {
  const ownedPath = ownedSessionSourcePath(sourcePath);
  if (entry.sourceState !== state || entry.sourceObservedAt !== observedAt
    || (ownedPath && ownedPath !== entry.sourcePath)) {
    entry.sourceState = state;
    entry.sourceObservedAt = observedAt;
    if (ownedPath) entry.sourcePath = ownedPath;
    changedKeys.add(key);
  }
}

function newestSessionObservation(entry) {
  return Math.max(0, Date.parse(entry?.capturedAt || '') || 0, Date.parse(entry?.sourceObservedAt || '') || 0,
    ...Object.values(entry?.periodWindows || {}).map((window) => Date.parse(window.capturedAt || '') || 0));
}

function reconcileSessionSources(archive, periods, liveKeys, source, excludedKeys, capturedAt, changedKeys, options, managedKeys, ownedClients) {
  const capturedAtIso = capturedAt.toISOString();
  const day = localDay(capturedAt);
  const month = localMonth(capturedAt);
  const rows = new Map(PERIODS.map((name) => [name, new Map(Object.values(periods.get(name).sessions || {})
    .map((row) => [sessionKey(row.client, row.sessionId), row]))]));
  for (const key of new Set([...Object.keys(archive.sessions), ...liveKeys])) {
    if (excludedKeys.has(key) || ownedClients.has(key.slice(0, key.indexOf(':')))) continue;
    let entry = archive.sessions[key];
    if (newestSessionObservation(entry) > capturedAt.getTime()) continue;
    if (!liveKeys.has(key)) {
      if (!entry) continue;
      const sourcePath = ownedSessionSourcePath(source.paths?.[key]) || entry.sourcePath;
      const classified = classifySessionSourcePath(sourcePath, options.sourceStateDeps);
      // An existing file says nothing about why parsing returned no usage.
      observeSessionSource(entry, classified === 'missing' ? 'missing' : 'unknown',
        sourcePath, capturedAtIso, changedKeys, key);
      continue;
    }
    const separator = key.indexOf(':');
    if (!entry) entry = archive.sessions[key] = {
      client: key.slice(0, separator), sessionId: key.slice(separator + 1),
      capturedAt: capturedAtIso, day, month, periodWindows: {}, periods: {}
    };
    observeSessionSource(entry, 'present', source.paths?.[key], capturedAtIso, changedKeys, key);
    for (const periodName of PERIODS) {
      if (periodName === 'today' && archive.prunedDay && day < archive.prunedDay) continue;
      if (periodName === 'month' && archive.prunedMonth && month < archive.prunedMonth) continue;
      const row = rows.get(periodName).get(key);
      const nextSession = row ? cloneJson(row) : periodName === 'allTime'
        ? normalizedSessionFrom({ client: entry.client, sessionId: entry.sessionId, totalTokens: 0 }, key) : null;
      if (nextSession) {
        if (managedKeys.has(key)) enrichSessionMetadata(nextSession, entry, periodName);
        delete nextSession.liveActivity;
        delete nextSession.waitingForInput;
        delete nextSession.sourcePath;
      }
      const nextWindow = { capturedAt: capturedAtIso };
      if (periodName === 'today') nextWindow.day = day;
      if (periodName === 'month') nextWindow.month = month;
      if (!sameJson(entry.periods[periodName], nextSession) || !sameJson(entry.periodWindows[periodName], nextWindow)) {
        if (nextSession) entry.periods[periodName] = nextSession;
        else delete entry.periods[periodName];
        entry.periodWindows[periodName] = nextWindow;
        changedKeys.add(key);
      }
    }
    entry.capturedAt = capturedAtIso;
    entry.day = day;
    entry.month = month;
  }
}

// Every capture asks the Cursor JSON cache about the legacy rows that still
// have no link, and a link, once written, is never revisited. A legacy row is
// one CSV event, keyed on that event's full timestamp, so its tokens can only
// change if tokscale folds a second event carrying the very same timestamp into
// it: that event is either in the conversation the link already names, or in a
// second one, in which case no single event ever matched the row and there was
// no link to invalidate. Deriving the work from the archive on each pass is
// also what makes a row another writer added arrive on its own.
function linkLegacyCursorEvents(archive, changedKeys, readCursorUsageEvents) {
  const pending = [];
  for (const [key, entry] of Object.entries(archive.sessions)) {
    if (entry.supersededBy || !isLegacyCursorEntry(entry)) continue;
    const lookup = legacyCursorLookup(entry);
    if (lookup) pending.push([key, entry, lookup]);
  }
  if (pending.length === 0) return;

  const usageEvents = readCursorUsageEvents();
  if (!usageEvents) return;
  for (const [key, entry, lookup] of pending) {
    const sessionId = supersedingCursorSessionId(lookup, usageEvents);
    if (!sessionId) continue;
    entry.supersededBy = sessionKey('cursor', sessionId);
    changedKeys.add(key);
  }
}

function captureSessionUsageArchive(existingArchive, deviceRecord, capturedAt = new Date()) {
  const archive = normalizeSessionUsageArchive(existingArchive);
  return updateSessionUsageArchive(archive, deviceRecord, capturedAt).archive;
}

function addSessionBreakdown(period, session) {
  const client = session.client;
  const cacheRead = Math.max(0, Math.round(numberValue(session.cacheReadTokens)));
  const cacheWrite = Math.max(0, Math.round(numberValue(session.cacheWriteTokens)));
  const output = Math.max(0, Math.round(numberValue(session.outputTokens)));

  if (cacheRead > 0) period.clientCacheReads[client] = (period.clientCacheReads[client] || 0) + cacheRead;
  if (cacheWrite > 0) period.clientCacheWrites[client] = (period.clientCacheWrites[client] || 0) + cacheWrite;
  if (output > 0) period.clientOutputs[client] = (period.clientOutputs[client] || 0) + output;

  const modelTokens = Object.entries(session.models || {})
    .map(([model, tokens]) => [model, numberValue(tokens)])
    .filter(([, tokens]) => tokens > 0);
  const totalModelTokens = modelTokens.reduce((sum, [, tokens]) => sum + tokens, 0);
  if (totalModelTokens === 0) return;
  if (modelTokens.length > 1) {
    for (const [model, tokens] of modelTokens) {
      period.modelUnclassifiedTokens[model] = (period.modelUnclassifiedTokens[model] || 0) + tokens;
    }
    period.capabilities.tokenComponents = false;
    return;
  }

  for (const [model, tokens] of modelTokens) {
    const cr = Math.min(tokens, cacheRead);
    const cw = Math.min(tokens - cr, cacheWrite);
    const ou = Math.min(tokens - cr - cw, output);
    if (cr > 0) period.modelCacheReads[model] = (period.modelCacheReads[model] || 0) + cr;
    if (cw > 0) period.modelCacheWrites[model] = (period.modelCacheWrites[model] || 0) + cw;
    if (ou > 0) period.modelOutputs[model] = (period.modelOutputs[model] || 0) + ou;
    const unclassified = Math.max(0, tokens - cr - cw - ou);
    if (unclassified > 0) {
      period.modelUnclassifiedTokens[model] = (period.modelUnclassifiedTokens[model] || 0) + unclassified;
      period.capabilities.tokenComponents = false;
    }
  }
}

function addArchivedSession(period, session, archiveKey = null, entry = {}) {
  if (isReasonixSyntheticSession(session)) return;
  const key = archiveKey || sessionKey(session.client, session.sessionId);
  if (!key || period.sessions[key]) return;

  const archived = cloneJson(session);
  delete archived.sourcePath;
  delete archived.archived;
  delete archived.deleted;
  delete archived.sourceDeleted;
  delete archived.waitingForInput;
  delete archived.retained;
  archived.sourceState = entry.sourceState === 'missing' && ownedSessionSourcePath(entry.sourcePath)
    ? 'missing' : 'unknown';
  delete archived.liveActivity;
  if (archived.sourceState === 'missing') archived.archived = true;
  else archived.retained = true;
  period.sessions[key] = archived;
  const tokens = Math.max(0, Math.round(numberValue(archived.totalTokens)));
  const cost = numberValue(archived.costUsd);
  const cacheRead = Math.max(0, Math.round(numberValue(archived.cacheReadTokens)));
  const cacheWrite = Math.max(0, Math.round(numberValue(archived.cacheWriteTokens)));
  const output = Math.max(0, Math.round(numberValue(archived.outputTokens)));

  period.totalTokens += tokens;
  period.costUsd += cost;
  period.cacheReadTokens += cacheRead;
  period.cacheWriteTokens += cacheWrite;
  period.outputTokens += output;
  const unclassified = Math.max(0, tokens - cacheRead - cacheWrite - output);
  if (unclassified > 0) {
    period.unclassifiedTokens += unclassified;
    period.clientUnclassifiedTokens[archived.client] = (period.clientUnclassifiedTokens[archived.client] || 0) + unclassified;
    period.capabilities.tokenComponents = false;
  }
  if (tokens > 0) period.clients[archived.client] = (period.clients[archived.client] || 0) + tokens;
  if (cost > 0) period.clientCosts[archived.client] = (period.clientCosts[archived.client] || 0) + cost;

  for (const [model, modelTokens] of Object.entries(archived.models || {})) {
    const next = Math.max(0, Math.round(numberValue(modelTokens)));
    if (next <= 0) continue;
    period.models[model] = (period.models[model] || 0) + next;
    if (!period.clientModels[archived.client]) period.clientModels[archived.client] = {};
    period.clientModels[archived.client][model] = (period.clientModels[archived.client][model] || 0) + next;
  }
  for (const [model, modelCost] of Object.entries(archived.modelCosts || {})) {
    const next = numberValue(modelCost);
    if (next <= 0) continue;
    period.modelCosts[model] = (period.modelCosts[model] || 0) + next;
    if (!period.clientModelCosts[archived.client]) period.clientModelCosts[archived.client] = {};
    period.clientModelCosts[archived.client][model] = (period.clientModelCosts[archived.client][model] || 0) + next;
  }

  addSessionBreakdown(period, archived);
}

// The session id is product-owned: the Pi-format header id is written by the
// client that produced the file, so one id belongs to exactly one product. That
// is what makes this an identity question rather than a heuristic.
function isLiveUnderSplitId(period, entry, session, archive, periodName, now, managedKeys) {
  const split = splitClientIdFor(session?.client);
  if (!split) return false;
  const sessionId = String(session?.sessionId || entry?.sessionId || '').trim();
  if (!sessionId) return false;
  const key = `${split}:${sessionId}`;
  return managedKeys.has(key) || Boolean(period?.sessions?.[key])
    || hasArchivedPeriodObservation(archive, key, periodName, now);
}

function shouldApplyPeriod(periodName, entry, now) {
  const window = entry?.periodWindows?.[periodName] || {};
  if (periodName === 'today') return (window.day || entry.day) === localDay(now);
  if (periodName === 'month') return (window.month || entry.month) === localMonth(now);
  return periodName === 'allTime';
}

// A corrected zero or cleared short period still owns the identity. Older
// merged/superseded copies must not replay just because that correction emits
// no visible usage row. Pruning drops the short-period observation with its row.
function hasArchivedPeriodObservation(archive, key, periodName, now) {
  const entry = archive?.sessions?.[key];
  return Boolean(entry && shouldApplyPeriod(periodName, entry, now)
    && (entry.periods?.[periodName]
      || (entry.periods?.allTime && entry.periodWindows?.[periodName]?.capturedAt)));
}

function scrubSessionArchiveSource(summary, options = {}) {
  const next = options.mutate === true ? summary : cloneJson(summary);
  delete next.sessionArchiveSource;
  const periodContainer = next.periods && typeof next.periods === 'object' ? next.periods : next;
  for (const periodName of PERIODS) {
    const period = periodContainer?.[periodName];
    if (period && typeof period === 'object' && Object.prototype.hasOwnProperty.call(period, 'sessions')) {
      period.sessions = filterReasonixSyntheticSessions(period.sessions);
      for (const session of Object.values(period.sessions || {})) delete session.sourcePath;
    }
  }
  return next;
}

function enrichSessionMetadata(session, entry, periodName) {
  const retained = entry?.periods?.[periodName] || entry?.periods?.allTime
    || entry?.periods?.month || entry?.periods?.today;
  if (!retained) return;
  // The daily projection owns every counter. Only fill absent descriptive
  // fields when an omitted native row could not supply its metadata.
  for (const field of ['title', 'sessionKind', 'nativeSessionId', 't3ThreadId']) {
    if (!session[field] && retained[field]) session[field] = retained[field];
  }
  if (!session.parentSessionId && retained.parentSessionId) {
    session.parentSessionId = retained.parentSessionId;
    if (retained.parentClient && retained.parentClient !== session.client) session.parentClient = retained.parentClient;
    else delete session.parentClient;
  }
  if (!session.projectId && retained.projectId) {
    session.projectId = retained.projectId;
    session.projectLabel = retained.projectLabel || '';
  } else if (session.projectId === retained.projectId && !session.projectLabel && retained.projectLabel) {
    session.projectLabel = retained.projectLabel;
  }
}

function enrichManagedSessionMetadata(summary, archive, managedKeys) {
  const periods = summary.periods && typeof summary.periods === 'object' ? summary.periods : summary;
  for (const periodName of PERIODS) {
    for (const key of managedKeys) {
      const session = periods[periodName]?.sessions?.[key];
      if (!session) continue;
      enrichSessionMetadata(session, archive.sessions[key], periodName);
    }
  }
}

function applySessionUsageArchive(summary, archive, options = {}) {
  const normalizedArchive = options.canonical === true
    ? canonicalSessionUsageArchive(archive)
    : normalizeSessionUsageArchive(archive);
  const now = toDate(options.now);
  const sourceManagedKeys = new Set(summary.sessionArchiveSource?.managedKeys || []);
  const managedKeys = new Set([...sourceManagedKeys, ...(summary.codexLocalSessionKeys || [])]);
  const checkedClients = new Set((summary.sessionArchiveSource?.boundaryCheckedClients || []).map(normalizeClientName));
  const ownedClients = new Set((summary.sessionArchiveSource?.ownedClients || []).map(normalizeClientName).filter(client => checkedClients.has(client)));
  const next = scrubSessionArchiveSource(summary, options);
  enrichManagedSessionMetadata(next, normalizedArchive, sourceManagedKeys);
  const targetPeriods = new Map();
  const targetFor = (periodName) => {
    if (!targetPeriods.has(periodName)) {
      const period = options.canonicalSummary === true
        ? (next.periods && typeof next.periods === 'object' ? next.periods[periodName] : next[periodName])
        : targetPeriod(next, periodName);
      targetPeriods.set(periodName, period);
    }
    return targetPeriods.get(periodName);
  };

  const supersededRows = [];
  const mergedRows = [];
  for (const [archiveKey, entry] of Object.entries(normalizedArchive.sessions)) {
    // The source/day projection already owns this ID, including a zero period.
    if (managedKeys.has(archiveKey) || ownedClients.has(entry.client)) continue;
    for (const periodName of PERIODS) {
      const session = entry.periods?.[periodName];
      if (!session || !hasSessionUsage(session) || !shouldApplyPeriod(periodName, entry, now)) continue;
      // Same rule as the client archive: never create a period the summary does
      // not have. A progressive preview is marked partial by the periods it
      // omits, and a partial that looks complete loses the attribution fields
      // deviceState would otherwise carry forward.
      if (!hasSummaryPeriod(next, periodName)) continue;
      const period = targetFor(periodName);
      if (period.sessions[archiveKey]) continue;
      // A row keyed under a merged id replays only after every other row: an
      // archived split-id copy of the same session is the same usage twice, and
      // the merged row can only see that overlap once the split row is already
      // in the period. Insertion order puts the older merged row first, so
      // deferring by identity is what makes the replay order-independent.
      if (splitClientIdFor(session.client || entry.client)) {
        mergedRows.push([period, archiveKey, entry, session, periodName]);
        continue;
      }
      if (entry.supersededBy) {
        supersededRows.push([period, archiveKey, session, entry.supersededBy, entry, periodName]);
        continue;
      }
      addArchivedSession(period, session, archiveKey, entry);
    }
  }

  for (const [period, archiveKey, entry, session, periodName] of mergedRows) {
    if (period.sessions[archiveKey]) continue;
    // An archived session captured while two clients shared one row is keyed
    // under the merged id, so the live split-id copy of the same session is a
    // different key. The split id's own scan is the authoritative source now —
    // it reports the same bytes the merged row was built from — so skip the
    // archived copy rather than adding it on top. The check runs late enough to
    // also see the split id's *archived* rows, which the first pass applied.
    if (isLiveUnderSplitId(period, entry, session, normalizedArchive, periodName, now, managedKeys)) continue;
    if (entry.supersededBy) {
      supersededRows.push([period, archiveKey, session, entry.supersededBy, entry, periodName]);
      continue;
    }
    addArchivedSession(period, session, archiveKey, entry);
  }

  // A legacy Cursor row whose event now belongs to another session is judged
  // after every other row has replayed, so that session counts whether it is
  // live or only archived. Without it the row is still the only record.
  for (const [period, archiveKey, session, supersededBy, entry, periodName] of supersededRows) {
    if (!managedKeys.has(supersededBy) && !period.sessions[supersededBy]
      && !hasArchivedPeriodObservation(normalizedArchive, supersededBy, periodName, now)) {
      addArchivedSession(period, session, archiveKey, entry);
    }
  }

  return next;
}

function sessionUsageArchivePath(options = {}) {
  return options.path || path.join(sharedDataDir(options), 'session-usage-archive.json');
}

function readSessionUsageArchive(options = {}) {
  const read = options.readJson || readJson;
  return normalizeSessionUsageArchive(read(sessionUsageArchivePath(options), {}));
}

function writeSessionUsageArchive(archive, options = {}) {
  const write = options.writeJsonAtomic || writeJsonAtomic;
  write(sessionUsageArchivePath(options), normalizeSessionUsageArchive(archive));
}

function clearSessionUsageArchive(options = {}) {
  const unlink = options.unlinkSync || fs.unlinkSync;
  try {
    unlink(sessionUsageArchivePath(options));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

module.exports = {
  addArchivedSession,
  applySessionUsageArchive,
  captureSessionUsageArchive,
  clearSessionUsageArchive,
  isSessionUsageArchiveEntryEvidence,
  isSessionUsageArchiveEvidence,
  normalizeSessionUsageArchive,
  readSessionUsageArchive,
  scrubSessionArchiveSource,
  sessionUsageArchiveDate,
  sessionUsageArchivePath,
  updateSessionUsageArchive,
  writeSessionUsageArchive
};
