/**
 * ha-session-history.js — Historical Browser Mod session resolver
 * Version: 2.0.0 — 2026-06-04
 *
 * Strategy: HA logbook/history API already stores every state_changed event
 * for every sensor.browser_mod_* entity. This module queries that history
 * and builds a per-user session timeline so Node can resolve WHAT DEVICE
 * a user was on at any point in the past — even after Node was offline.
 *
 * Data flow:
 *   HA recorder → stores browser_mod sensor states (keep for 90 days)
 *   Node queries → /api/history/period/<since>?filter_entity_id=...
 *   This module → builds timeline { userName -> [ {hash, ua, from, until} ] }
 *   server.js   → calls resolveSessionAtTime(userName, actionTimestamp)
 *
 * Performance design:
 *   - Cache the timeline in memory for CACHE_TTL_MS (default 5 min)
 *   - Only re-fetch when cache expires or explicitly invalidated
 *   - Only fetch the sensor types we need (useragent + user) — not all BM sensors
 *   - Batch all entity IDs into one HTTP request per fetch
 */

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ── Known Browser Mod session hashes ─────────────────────────────────────────
// Add every hash you see in your HA. Node auto-discovers new ones too (see below).
const KNOWN_HASHES = [
  '9bc6ba13_2a5d956b',   // smt_admin — Windows Chrome
  '99f1ee5f_37f19c48',   // Abdallah Kanash — Windows Chrome
  '20352a1e_a52cb1f5',   // Abdallah Kanash — iPhone HA App
  // Add more as users connect new devices
];

// ── Cache ────────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let sessionTimeline = {};  // userName (lowercase) -> [ { hash, ua, platform, browser, from_ts, until_ts } ]
let lastFetchAt     = 0;
let lastFetchHours  = 0;

// ── Helpers ──────────────────────────────────────────────────────────────────
function haHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function haGet(haUrl, path, token) {
  const r = await fetch(`${haUrl}/api${path}`, { headers: haHeaders(token), timeout: 15000 });
  if (!r.ok) throw new Error(`HA ${r.status} — ${path}`);
  return r.json();
}

/**
 * Build the list of entity IDs to query.
 * We only need _browser_useragent and _browser_user — not path/width/height etc.
 * This keeps the history payload small.
 */
function buildEntityList(extraHashes = []) {
  const allHashes = [...new Set([...KNOWN_HASHES, ...extraHashes])];
  const entities = [];
  allHashes.forEach(hash => {
    entities.push(`sensor.browser_mod_${hash}_browser_useragent`);
    entities.push(`sensor.browser_mod_${hash}_browser_user`);
  });
  return entities;
}

/**
 * Auto-discover hashes from live HA states (catches new devices not in KNOWN_HASHES).
 */
async function discoverHashes(haUrl, token) {
  try {
    const states = await haGet(haUrl, '/states', token);
    const discovered = [];
    states.forEach(s => {
      const m = s.entity_id.match(/^sensor\.browser_mod_([a-f0-9_]+)_browser_useragent$/);
      if (m && !KNOWN_HASHES.includes(m[1])) {
        discovered.push(m[1]);
      }
    });
    return discovered;
  } catch(_) { return []; }
}

// ── Core: fetch and build timeline ───────────────────────────────────────────
/**
 * Fetch Browser Mod history from HA and build a session timeline.
 *
 * Timeline structure:
 * {
 *   "smt_admin": [
 *     { hash: "9bc6ba13_2a5d956b", ua: "Mozilla...", platform: "Windows Browser",
 *       browser: "Chrome 148", from_ts: 1717488000000, until_ts: 1717491600000 },
 *     ...
 *   ],
 *   "abdallah kanash": [ ... ]
 * }
 *
 * Each entry means: this user was on this device from `from_ts` to `until_ts`.
 * until_ts = null means the session is still active (last known state).
 */
async function buildTimeline(haUrl, token, hours = 48) {
  const since = new Date(Date.now() - hours * 3600000).toISOString();

  // Step 1: discover any new hashes
  const extraHashes = await discoverHashes(haUrl, token);
  const entities    = buildEntityList(extraHashes);

  // Step 2: fetch history for all entities in ONE request
  // HA history API returns: [ [ {entity_id, state, last_changed, ...}, ... ], ... ]
  // One inner array per entity_id requested
  const entityParam = entities.join(',');
  let historyData;
  try {
    historyData = await haGet(
      haUrl,
      `/history/period/${since}?filter_entity_id=${entityParam}&minimal_response&no_attributes`,
      token
    );
  } catch(e) {
    console.warn('[SessionHistory] History fetch failed:', e.message);
    return {};
  }

  if (!Array.isArray(historyData)) return {};

  // Step 3: organize by entity_id
  // Map: entity_id -> array of { state, last_changed }
  const byEntity = {};
  historyData.forEach(entityHistory => {
    if (!Array.isArray(entityHistory) || !entityHistory.length) return;
    const eid = entityHistory[0].entity_id;
    byEntity[eid] = entityHistory.map(h => ({
      state:       h.state,
      last_changed: h.last_changed || h.lu, // minimal_response uses 'lu'
    })).filter(h => h.state && h.state !== 'unavailable' && h.state !== 'unknown');
  });

  // Step 4: build per-hash UA timeline
  // For each hash, merge _browser_useragent and _browser_user histories into intervals
  const hashTimelines = {}; // hash -> [ { user, ua, from_ts, until_ts } ]
  const allHashes = [...new Set([...KNOWN_HASHES, ...extraHashes])];

  allHashes.forEach(hash => {
    const uaHistory   = byEntity[`sensor.browser_mod_${hash}_browser_useragent`] || [];
    const userHistory = byEntity[`sensor.browser_mod_${hash}_browser_user`]      || [];

    if (!uaHistory.length && !userHistory.length) return;

    // Build a unified event timeline for this hash
    // Each event: { ts, type: 'ua'|'user', value }
    const events = [];
    uaHistory.forEach(h => events.push({ ts: new Date(h.last_changed).getTime(), type: 'ua',   value: h.state }));
    userHistory.forEach(h => events.push({ ts: new Date(h.last_changed).getTime(), type: 'user', value: h.state }));
    events.sort((a, b) => a.ts - b.ts);

    // Walk events and build intervals
    let currentUa   = null;
    let currentUser = null;
    let intervalStart = null;
    const intervals = [];

    events.forEach(ev => {
      // Close the previous interval if we have enough data
      if (currentUa && currentUser && intervalStart !== null) {
        intervals.push({
          user:      currentUser,
          ua:        currentUa,
          from_ts:   intervalStart,
          until_ts:  ev.ts,
        });
      }
      if (ev.type === 'ua')   currentUa   = ev.value;
      if (ev.type === 'user') currentUser = ev.value;
      intervalStart = ev.ts;
    });

    // Push final open interval (session still active)
    if (currentUa && currentUser && intervalStart !== null) {
      intervals.push({
        user:      currentUser,
        ua:        currentUa,
        from_ts:   intervalStart,
        until_ts:  null, // still active
      });
    }

    hashTimelines[hash] = intervals;
  });

  // Step 5: group intervals by user name
  const timeline = {};
  Object.entries(hashTimelines).forEach(([hash, intervals]) => {
    intervals.forEach(interval => {
      const userName = (interval.user || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
      if (!userName || userName === 'anonymous') return;
      if (!timeline[userName]) timeline[userName] = [];
      timeline[userName].push({ hash, ua: interval.ua, from_ts: interval.from_ts, until_ts: interval.until_ts });
    });
  });

  // Step 6: parse UA for each entry (do this once, cache the result)
  const { parseUserAgent } = require('./ha-ws');
  Object.values(timeline).forEach(entries => {
    entries.forEach(e => {
      const parsed  = parseUserAgent(e.ua);
      e.platform    = parsed.platform;
      e.browser     = parsed.browser;
      e.is_mobile   = parsed.is_mobile;
      e.is_ha_app   = parsed.is_ha_app;
      e.icon        = parsed.icon;
    });
  });

  console.log(`[SessionHistory] Built timeline: ${Object.keys(timeline).length} users, `
    + `${Object.values(timeline).reduce((s,a)=>s+a.length,0)} total session intervals`
    + ` (last ${hours}h)`);

  return timeline;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch (or return cached) session timeline.
 * Re-fetches if cache is older than CACHE_TTL_MS or hours changed.
 */
async function getTimeline(haUrl, token, hours = 48) {
  const now = Date.now();
  if (
    sessionTimeline &&
    Object.keys(sessionTimeline).length > 0 &&
    (now - lastFetchAt) < CACHE_TTL_MS &&
    lastFetchHours === hours
  ) {
    return sessionTimeline;
  }
  sessionTimeline = await buildTimeline(haUrl, token, hours);
  lastFetchAt     = now;
  lastFetchHours  = hours;
  return sessionTimeline;
}

/**
 * Resolve what session a user was on at a specific past timestamp.
 *
 * Algorithm:
 * 1. Get all session intervals for this user
 * 2. Find intervals where from_ts <= actionTs <= until_ts
 *    (or until_ts is null = still active)
 * 3. If multiple overlap (user had multiple devices), pick the one
 *    whose from_ts is closest to actionTs (most recently started)
 * 4. If no exact match, fall back to the interval that ended closest
 *    before the action (within MAX_GAP_MS)
 *
 * Returns: { hash, ua, platform, browser, is_mobile, is_ha_app } or null
 */
async function resolveSessionAtTime(haUrl, token, userName, actionTimestamp, hours = 48) {
  if (!userName || !actionTimestamp) return null;

  const timeline  = await getTimeline(haUrl, token, hours);
  const uLow      = userName.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const actionTs  = new Date(actionTimestamp).getTime();
  const MAX_GAP_MS = 30 * 60 * 1000; // 30 minutes — if session ended up to 30min before action, still use it

  // Try exact user name match first, then partial
  let entries = timeline[uLow];
  if (!entries || !entries.length) {
    // Partial match: "abdallah kanash" matches "abdallah"
    const key = Object.keys(timeline).find(k =>
      k.includes(uLow.split(' ')[0]) || uLow.includes(k.split(' ')[0])
    );
    entries = key ? timeline[key] : null;
  }
  if (!entries || !entries.length) return null;

  // Find intervals that cover the action timestamp
  const covering = entries.filter(e => {
    const from  = e.from_ts;
    const until = e.until_ts ?? (Date.now() + 86400000); // null = still active
    return actionTs >= from && actionTs <= until;
  });

  if (covering.length) {
    // Pick most recently started interval (most specific)
    covering.sort((a, b) => b.from_ts - a.from_ts);
    return covering[0];
  }

  // No exact cover — find nearest interval that ended before the action
  const before = entries
    .filter(e => e.until_ts !== null && e.until_ts < actionTs && (actionTs - e.until_ts) <= MAX_GAP_MS)
    .sort((a, b) => b.until_ts - a.until_ts);

  return before.length ? before[0] : null;
}

/**
 * Force-invalidate the cache (call this after Node restarts or on demand).
 */
function invalidateCache() {
  sessionTimeline = {};
  lastFetchAt     = 0;
  console.log('[SessionHistory] Cache invalidated');
}

/**
 * Add a new hash to the known list at runtime (when a new device is seen).
 */
function registerHash(hash) {
  if (!KNOWN_HASHES.includes(hash)) {
    KNOWN_HASHES.push(hash);
    invalidateCache(); // rebuild timeline to include new hash
    console.log('[SessionHistory] Registered new hash:', hash);
  }
}

module.exports = {
  resolveSessionAtTime,
  getTimeline,
  invalidateCache,
  registerHash,
  KNOWN_HASHES,
};