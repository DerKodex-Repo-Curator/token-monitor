'use strict';

const { isDeepStrictEqual } = require('node:util');

// Released generic archives predate the #775 tracked-client rename. These
// names are not scanner identities, and the display alias heuristic is not a
// compatibility decoder for arbitrary stored identities.
const RELEASED_CLIENT_ALIASES = Object.freeze({ micode: 'mimo' });
const releasedArchiveClient = client => Object.hasOwn(RELEASED_CLIENT_ALIASES, client)
  ? RELEASED_CLIENT_ALIASES[client] : client;

function stableJson(value) {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

// Keep all literal observations on disk. Only their display/boundary view is
// folded. On an unresolved collision the existing legacy whole-observation
// floor chooses a period; it never sums copies or mixes component maxima.
function sessionArchiveProjectionEntries(archive, include = () => true) {
  const groups = new Map();
  for (const [rawKey, rawEntry] of Object.entries(archive?.sessions || {})) {
    if (!include(rawKey, rawEntry)) continue;
    const client = releasedArchiveClient(rawEntry.client), key = `${client}:${rawEntry.sessionId}`;
    const entry = { ...rawEntry, client, periods: Object.fromEntries(Object.entries(rawEntry.periods || {})
      .map(([name, row]) => [name, { ...row, client }])) };
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, entries]) => {
    if (entries.length === 1) return [key, entries[0]];
    const rank = (entry, name) => [name === 'today' ? entry.periodWindows?.today?.day || entry.day || ''
      : name === 'month' ? entry.periodWindows?.month?.month || entry.month || '' : '',
    entry.periods[name]?.totalTokens || 0, entry.periods[name]?.costUsd || 0,
    entry.periodWindows?.[name]?.capturedAt || entry.capturedAt || '', stableJson(entry)];
    const compare = (a, b, name) => {
      const left = rank(a, name), right = rank(b, name);
      for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
      return 0;
    };
    const next = { ...entries.slice().sort((a, b) => compare(a, b, 'allTime')).at(-1), periods: {}, periodWindows: {},
      aliasConflict: entries.some(entry => !isDeepStrictEqual(entry, entries[0])) };
    for (const name of ['today', 'month', 'allTime']) {
      const selected = entries.filter(entry => entry.periods[name]).sort((a, b) => compare(a, b, name)).at(-1);
      if (!selected) continue;
      next.periods[name] = selected.periods[name];
      const window = selected.periodWindows?.[name] || {};
      // A period can come from a different observation than allTime. Resolve
      // its sparse envelope before the chosen allTime metadata can replace it.
      next.periodWindows[name] = { ...window, capturedAt: window.capturedAt || selected.capturedAt,
        ...(name === 'today' ? { day: window.day || selected.day }
          : name === 'month' ? { month: window.month || selected.month } : {}) };
    }
    return [key, next];
  });
}

module.exports = { RELEASED_CLIENT_ALIASES, releasedArchiveClient, sessionArchiveProjectionEntries };
