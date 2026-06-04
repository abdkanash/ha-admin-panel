const express       = require('express');
const cors          = require('cors');
const path          = require('path');
const haWS          = require('./ha-ws');
const sessionHist   = require('./ha-session-history');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
require('dotenv').config();

// HA Admin Panel — server.js
// Version: 2.0.0 — 2026-06-04
// Changelog: see CHANGELOG.md

const app = express();
const PORT = process.env.PORT || 3001;
const HA_URL = (process.env.HA_URL || 'http://homeassistant.local:8123').replace(/\/$/, '');
const HA_TOKEN = process.env.HA_TOKEN || '';

app.use(cors());
app.use(express.json());
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

function requireToken(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '').trim();
  req.haToken = token || HA_TOKEN;
  if (!req.haToken) return res.status(401).json({ error: 'No HA token provided.' });
  next();
}

async function haGet(path, token) {
  const r = await fetch(`${HA_URL}/api${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 10000
  });
  if (!r.ok) throw new Error(`HA ${r.status} ${r.statusText} — ${path}`);
  const ct = r.headers.get('content-type') || '';
  return ct.includes('application/json') ? r.json() : r.text();
}

async function haPost(path, token, body = {}) {
  const r = await fetch(`${HA_URL}/api${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`HA ${r.status} ${r.statusText} — ${path}`);
  const ct = r.headers.get('content-type') || '';
  return ct.includes('application/json') ? r.json() : { ok: true };
}

async function haDelete(path, token) {
  const r = await fetch(`${HA_URL}/api${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) throw new Error(`HA ${r.status} ${r.statusText}`);
  return r.status === 204 ? { ok: true } : r.json();
}

// ── Health ──────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', haUrl: HA_URL }));

app.get('/api/connect', requireToken, async (req, res) => {
  try {
    const data = await haGet('/', req.haToken);
    // Start WebSocket subscriber for real-time event capture
    if (!haWS.isConnected()) {
      haWS.connectWS(HA_URL, req.haToken);
    }
    // Pre-load Browser Mod states immediately via REST so sessions are ready
    // before any device log requests come in (don't wait for WS state_changed events)
    try {
      const allStates = await haGet('/states', req.haToken);
      const bmStates  = allStates.filter(s => s.entity_id.startsWith('sensor.browser_mod_'));
      if (bmStates.length > 0) {
        haWS.preloadBrowserModStates(bmStates);
        console.log('[REST] Pre-loaded', bmStates.length, 'Browser Mod sensor states');
      }
    } catch(_) {}
    res.json({ connected: true, message: typeof data === 'object' ? data.message : data, url: HA_URL });
  } catch (e) {
    res.status(502).json({ connected: false, error: e.message });
  }
});

// ── System ──────────────────────────────────────────────────────────────────
app.get('/api/system/info', requireToken, async (req, res) => {
  try {
    const config = await haGet('/config', req.haToken);
    res.json({ config });
  } catch (e) {
    console.warn('system/info:', e.message);
    // Return empty config rather than 502 so UI doesn't break
    res.json({ config: {}, error: e.message });
  }
});

// ── States / Devices ────────────────────────────────────────────────────────
app.get('/api/devices/states', requireToken, async (req, res) => {
  try {
    res.json(await haGet('/states', req.haToken));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/devices/summary', requireToken, async (req, res) => {
  try {
    const states = await haGet('/states', req.haToken);
    const unavailable = states.filter(s => s.state === 'unavailable' || s.state === 'unknown');
    const lowBattery = states.filter(s => {
      const b = s.attributes?.battery_level ?? s.attributes?.battery;
      return b !== undefined && Number(b) < 20;
    });
    const domains = {};
    states.forEach(s => { const d = s.entity_id.split('.')[0]; domains[d] = (domains[d] || 0) + 1; });
    res.json({
      total: states.length,
      unavailable: unavailable.length,
      lowBattery: lowBattery.length,
      domains,
      unavailableEntities: unavailable.map(s => s.entity_id)
    });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/devices/service', requireToken, async (req, res) => {
  const { domain, service, entity_id, data = {} } = req.body;
  if (!domain || !service) return res.status(400).json({ error: 'domain and service required' });
  try {
    res.json(await haPost(`/services/${domain}/${service}`, req.haToken, { entity_id, ...data }));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── Automations ─────────────────────────────────────────────────────────────
app.get('/api/automations', requireToken, async (req, res) => {
  try {
    const states = await haGet('/states', req.haToken);
    res.json(states
      .filter(s => s.entity_id.startsWith('automation.'))
      .map(a => ({
        entity_id: a.entity_id,
        friendly_name: a.attributes?.friendly_name || a.entity_id,
        state: a.state,
        last_triggered: a.attributes?.last_triggered,
        mode: a.attributes?.mode,
        current: a.attributes?.current
      }))
    );
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/automations/:id/toggle', requireToken, async (req, res) => {
  try { res.json(await haPost('/services/automation/toggle', req.haToken, { entity_id: req.params.id })); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/automations/:id/trigger', requireToken, async (req, res) => {
  try { res.json(await haPost('/services/automation/trigger', req.haToken, { entity_id: req.params.id })); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ── USERS — derived from entity + logbook (REST API doesn't expose /config/auth/users) ──
// We use /api/states to find person entities and /api/logbook for activity
app.get('/api/users', requireToken, async (req, res) => {
  try {
    const states = await haGet('/states', req.haToken);
    // person.* entities represent tracked people/users
    const persons = states.filter(s => s.entity_id.startsWith('person.'));
    // input_boolean / device_tracker as supplementary
    const trackers = states.filter(s => s.entity_id.startsWith('device_tracker.'));

    const users = persons.map(p => ({
      id: p.entity_id,
      name: p.attributes?.friendly_name || p.entity_id.replace('person.',''),
      entity_id: p.entity_id,
      state: p.state,            // home / away / not_home
      last_changed: p.last_changed,
      last_updated: p.last_updated,
      source: p.attributes?.source || '—',
      user_id: p.attributes?.user_id || null,
      type: 'person'
    }));

    // Also add device_trackers not linked to a person
    const linkedSources = new Set(persons.map(p => p.attributes?.source).filter(Boolean));
    trackers
      .filter(t => !linkedSources.has(t.entity_id))
      .forEach(t => users.push({
        id: t.entity_id,
        name: t.attributes?.friendly_name || t.entity_id.replace('device_tracker.',''),
        entity_id: t.entity_id,
        state: t.state,
        last_changed: t.last_changed,
        last_updated: t.last_updated,
        source: t.attributes?.source_type || 'tracker',
        user_id: null,
        type: 'tracker'
      }));

    res.json(users);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── TOKENS — HA REST API does not expose refresh tokens; return meaningful info ──
app.get('/api/users/tokens', requireToken, async (req, res) => {
  try {
    // We can get logbook events for auth activity as a proxy
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    let logbook = [];
    try {
      logbook = await haGet(`/logbook/${since}?entity_id=persistent_notification`, req.haToken);
    } catch (_) {}

    // Fetch logbook for auth-related events (error_log not available on all HA versions)
    const events = [];
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const logbook = await haGet('/logbook/' + since, req.haToken);
      if (Array.isArray(logbook)) {
        logbook
          .filter(e => /auth|login|token|access/i.test(JSON.stringify(e)))
          .slice(0, 30)
          .forEach((e, i) => {
            events.push({
              id: 'tok_' + i,
              client_id: e.name || e.entity_id || 'auth event',
              created_at: e.when || new Date().toISOString(),
              last_used_at: e.when || null,
              line: [e.name, e.message, e.domain].filter(Boolean).join(' — ').slice(0, 200)
            });
          });
      }
    } catch (_) {}

    res.json({
      note: 'Full token list requires HA WebSocket API. Showing auth-related logbook events.',
      events,
      manage_url: HA_URL + '/profile'
    });
  } catch (e) { res.status(502).json({ error: e.message }); }
});


// ════════════════════════════════════════════════════════════════════════════
//  LOGGING SYSTEM — 3 dedicated endpoints
//  Sources confirmed: /api/logbook ✓  /api/states ✓  /api/events ✓
//  Not available:    /api/error_log (404)  /api/system_health (404)
// ════════════════════════════════════════════════════════════════════════════

// ── User ID → Name lookup table (built from states) ─────────────
let userLookupCache = {};
let userLookupExpiry = 0;

// Known user IDs — populated on first device log request from states scan
// ── Persistent resolution cache — saved to disk ──────────────────────────────
// Survives server restarts — once context_id is resolved, it never changes
const CACHE_FILE = path.join(__dirname, 'resolution_cache.json');
let resolvedCache = {};

// Load cache from disk on startup
try {
  if (require('fs').existsSync(CACHE_FILE)) {
    resolvedCache = JSON.parse(require('fs').readFileSync(CACHE_FILE, 'utf8'));
    console.log('[Cache] Loaded', Object.keys(resolvedCache).length, 'resolved entries from disk');
  }
} catch(e) {
  console.warn('[Cache] Could not load cache file:', e.message);
  resolvedCache = {};
}

// Save cache to disk (debounced — max once per 10s)
let cacheSaveTimer = null;
function saveCache() {
  if (cacheSaveTimer) return;
  cacheSaveTimer = setTimeout(() => {
    cacheSaveTimer = null;
    try {
      require('fs').writeFileSync(CACHE_FILE, JSON.stringify(resolvedCache), 'utf8');
    } catch(e) {
      console.warn('[Cache] Save failed:', e.message);
    }
  }, 10000);
}

const knownUserIds = {
  // Maps context_user_id -> Browser Mod session.user (must match EXACTLY)
  // session.user comes from sensor.browser_mod_*_browser_user state value
  'd061b1ced0b14049a3a141fa18c96b13': 'smt_admin',
  '72d2cc3f3fd94ee7b540d031cba686c6': 'Samira(GM)',
  '9fc8ff5cea6c479c9b320215ac98abd5': 'HR',
  '3492b2cb01a345e88a8b009d85e1be16': 'omar',
  '6750674ddb664b04a4ba52b4f1692215': 'Abdallah Kanash',
};

// Device tracker entity -> device info cache
const deviceTrackerCache = {};

async function buildUserLookup(token) {
  if (Date.now() < userLookupExpiry) return userLookupCache;
  try {
    const states = await haGet('/states', token);
    const lookup = {};
    // Extract person/device names from companion app sensor entities
    // Pattern: "AbdKanash iPhone Battery State" -> person = "AbdKanash"
    // Pattern: "SM-S938B Battery state" -> device = "SM-S938B"
    states
      .filter(s => /iphone|android|sm_s|galaxy|pixel|mobile|companion/i.test(s.entity_id))
      .forEach(s => {
        const name = (s.attributes && s.attributes.friendly_name) || '';
        if (!name) return;
        // Strip sensor suffix to get person/device name
        const stripped = name
          .replace(/\s+(Battery State|Battery state|SSID|BSSID|Last Update Trigger|Focus|Connection Type|SIM \d|App Version|Audio Output|Location permission|Charger type|geocoded location)$/i, '')
          .trim();
        if (stripped && stripped.length > 1 && stripped !== name) {
          // Use entity prefix as key: abdkanash_iphone -> AbdKanash
          const prefix = s.entity_id.replace(/^(sensor|binary_sensor|device_tracker|notify)\./, '').split('_')[0];
          lookup['name:' + prefix.toLowerCase()] = stripped;
          lookup['label:' + stripped] = stripped;
        }
      });
    userLookupCache = lookup;
    userLookupExpiry = Date.now() + 5 * 60000;
    return lookup;
  } catch (e) {
    return {};
  }
}

// Classify a logbook entry into trigger type + enriched metadata
function parseContext(e) {
  const userId    = e.context_user_id    || null;
  const evtType   = e.context_event_type || null;
  const ctxDomain = e.context_domain     || null;
  const ctxSvc    = e.context_service    || null;
  const ctxSrc    = e.context_source     || e.source || null;
  const ctxName   = e.context_name       || null;
  const ctxMsg    = e.context_message    || e.message || null;
  const ctxEntity = e.context_entity_id  || null;
  const ctxEntityName = e.context_entity_id_name || null;

  let triggerType, triggerLabel, platform;

  if (evtType === 'call_service' && userId) {
    // User triggered via HA app or browser — has both user_id and call_service
    triggerType  = 'MANUAL';
    triggerLabel = knownUserIds[userId] || ('uid:' + userId.slice(0, 12));
    platform     = 'app';
  } else if (evtType === 'automation_triggered' || ctxDomain === 'automation') {
    // Automation with explicit trigger context
    triggerType  = 'AUTOMATION';
    triggerLabel = ctxName || ctxEntityName || ctxEntity || 'Automation';
    platform     = ctxSrc === 'time'    ? 'schedule'
                 : ctxSrc === 'webhook' ? 'webhook'
                 : 'automation';
  } else if (ctxSrc === 'webhook') {
    triggerType  = 'WEBHOOK';
    triggerLabel = ctxName || 'Webhook';
    platform     = 'webhook';
  } else if (ctxEntity && !userId && !evtType) {
    // Cascaded from another entity — group/virtual switch reaction
    triggerType  = 'CASCADE';
    triggerLabel = ctxEntityName || ctxEntity;
    platform     = 'entity';
  } else {
    // No context fields at all = wall switch / physical button press
    // Also covers: only state+entity+name+when with no context_*
    // These are direct hardware actions (Tasmota/Shelly physical buttons)
    triggerType  = 'PHYSICAL';
    triggerLabel = 'Wall Switch / Physical';
    platform     = 'physical';
  }

  return {
    user_id:             userId,
    trigger_type:        triggerType,
    trigger_label:       triggerLabel,
    platform:            platform,
    service:             ctxSvc,
    source:              ctxSrc,
    automation_name:     ctxName,
    automation_entity:   ctxEntity,
    automation_msg:      ctxMsg,
    context_entity_id:   ctxEntity,
    context_entity_name: ctxEntityName,
  };
}


// Helper: detect action type from logbook entry
function classifyEntry(e) {
  const msg  = (e.message || '').toLowerCase();
  const name = (e.name    || '').toLowerCase();
  const dom  = e.domain   || (e.entity_id ? e.entity_id.split('.')[0] : '');

  if (/turned on|turned_on|switch.*on|light.*on/i.test(msg + name))  return { action:'ON',    icon:'power',    color:'green' };
  if (/turned off|turned_off|switch.*off|light.*off/i.test(msg + name)) return { action:'OFF', icon:'power-off', color:'red'   };
  if (/locked/i.test(msg + name))   return { action:'LOCKED',   icon:'lock',        color:'amber' };
  if (/unlocked/i.test(msg + name)) return { action:'UNLOCKED', icon:'lock-open',   color:'red'   };
  if (/triggered/i.test(msg + name)) return { action:'TRIGGER', icon:'bolt',        color:'purple'};
  if (/opened/i.test(msg + name))   return { action:'OPEN',     icon:'door-enter',  color:'amber' };
  if (/closed/i.test(msg + name))   return { action:'CLOSE',    icon:'door-exit',   color:'blue'  };
  if (dom === 'automation')         return { action:'AUTO',     icon:'robot',       color:'cyan'  };
  if (dom === 'script')             return { action:'SCRIPT',   icon:'terminal-2',  color:'cyan'  };
  if (dom === 'scene')              return { action:'SCENE',    icon:'wand',        color:'purple'};
  return { action:'EVENT', icon:'activity', color:'gray' };
}

// ── SYSTEM LOG — logbook + states anomalies ─────────────────────────────────
app.get('/api/logs/system', requireToken, async (req, res) => {
  const { level, limit = 300, hours = 24 } = req.query;
  const entries = [];
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  // logbook
  try {
    const since = new Date(Date.now() - Number(hours) * 3600000).toISOString();
    const lb = await haGet('/logbook/' + since, req.haToken);
    if (Array.isArray(lb)) {
      lb.forEach((e, i) => {
        const msg = [e.name, e.message].filter(Boolean).join(' — ') || 'event';
        let lvl = 'INFO';
        if (/error|fail|unavailable|critical|denied|exception/i.test(msg)) lvl = 'CRITICAL';
        else if (/warn|low|offline|unknown|timeout|disconnect/i.test(msg)) lvl = 'WARNING';
        const ts = e.when ? new Date(e.when).toISOString().slice(0,19).replace('T',' ') : now;
        const ctx = parseContext(e);
        entries.push({
          id: 'lb_' + i, timestamp: ts, level: lvl,
          component: (e.domain || (e.entity_id||'').split('.')[0] || 'logbook').slice(0,40),
          entity_id: e.entity_id || null,
          message: msg.slice(0, 300),
          source: 'logbook',
          user_id: ctx.user_id,
          user_name: ctx.user_name
        });
      });
    }
  } catch(e) { console.warn('logbook:', e.message); }

  // States: unavailable + low battery
  try {
    const states = await haGet('/states', req.haToken);
    states.filter(s => s.state==='unavailable'||s.state==='unknown').slice(0,80).forEach((s,i) => {
      const ts = s.last_changed ? new Date(s.last_changed).toISOString().slice(0,19).replace('T',' ') : now;
      entries.push({
        id:'sv_'+i, timestamp:ts, level:'WARNING',
        component: s.entity_id.split('.')[0],
        entity_id: s.entity_id,
        message: s.entity_id + ' is ' + s.state + (s.attributes&&s.attributes.friendly_name ? ' ('+s.attributes.friendly_name+')' : ''),
        source:'states', user_id:null, user_name:null
      });
    });
    states.filter(s => { const b=s.attributes&&(s.attributes.battery_level??s.attributes.battery); return b!==undefined&&Number(b)<15; }).slice(0,20).forEach((s,i) => {
      const b = s.attributes.battery_level??s.attributes.battery;
      const ts = s.last_changed ? new Date(s.last_changed).toISOString().slice(0,19).replace('T',' ') : now;
      entries.push({
        id:'bt_'+i, timestamp:ts, level:'CRITICAL',
        component: s.entity_id.split('.')[0],
        entity_id: s.entity_id,
        message: s.entity_id + ' battery critically low: ' + b + '%',
        source:'battery', user_id:null, user_name:null
      });
    });
  } catch(e) { console.warn('states:', e.message); }

  entries.sort((a,b) => b.timestamp.localeCompare(a.timestamp));
  const filtered = level ? entries.filter(e => e.level===level.toUpperCase()) : entries;
  res.json(filtered.slice(0, Number(limit)));
});

// ── AUTH LOG — login events, access tokens, user actions ───────────────────
app.get('/api/logs/auth', requireToken, async (req, res) => {
  const { limit = 200, hours = 48 } = req.query;
  const entries = [];
  const now = new Date().toISOString().slice(0,19).replace('T',' ');

  try {
    const since = new Date(Date.now() - Number(hours) * 3600000).toISOString();
    const lb = await haGet('/logbook/' + since, req.haToken);
    if (Array.isArray(lb)) {
      lb.forEach((e, i) => {
        const fullText = JSON.stringify(e).toLowerCase();
        // Only auth-related entries
        if (!/auth|login|token|user|access|session|credential|password|mfa|sign/i.test(fullText)) return;
        const msg  = [e.name, e.message].filter(Boolean).join(' — ') || 'auth event';
        const ctx  = parseContext(e);
        const ts   = e.when ? new Date(e.when).toISOString().slice(0,19).replace('T',' ') : now;
        let result = 'UNKNOWN';
        if (/success|logged in|authenticated/i.test(msg)) result = 'SUCCESS';
        else if (/fail|invalid|denied|blocked|wrong/i.test(msg)) result = 'FAILED';
        else if (/logout|sign out|revoked/i.test(msg)) result = 'LOGOUT';
        entries.push({
          id:'auth_'+i, timestamp:ts,
          result, message: msg.slice(0,300),
          user_id:   ctx.user_id,
          user_name: ctx.user_name || e.name || '—',
          entity_id: e.entity_id || null,
          domain:    e.domain || 'auth',
          source:    'logbook'
        });
      });
    }
  } catch(e) { console.warn('auth logbook:', e.message); }

  // Supplement with persons' last_changed as proxy for activity
  try {
    const states = await haGet('/states', req.haToken);
    states.filter(s => s.entity_id.startsWith('person.')).forEach((s,i) => {
      const ts = s.last_changed ? new Date(s.last_changed).toISOString().slice(0,19).replace('T',' ') : now;
      entries.push({
        id:'per_'+i, timestamp:ts,
        result: 'INFO',
        message: (s.attributes&&s.attributes.friendly_name||s.entity_id) + ' state changed → ' + s.state,
        user_id: s.attributes&&s.attributes.user_id || null,
        user_name: s.attributes&&s.attributes.friendly_name || s.entity_id,
        entity_id: s.entity_id,
        domain: 'person',
        source: 'states'
      });
    });
  } catch(e) {}

  entries.sort((a,b) => b.timestamp.localeCompare(a.timestamp));
  res.json(entries.slice(0, Number(limit)));
});

// ── DEVICE ACTION LOG — full who/when/how with user resolution ──────────────
app.get('/api/logs/devices', requireToken, async (req, res) => {
  const { limit = 400, hours = 24, domain } = req.query;
  const entries = [];
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  // Build user name lookup from companion app sensors
  await buildUserLookup(req.haToken);

  // Load ALL states once — used for user resolution, device detection, and HA-stored sessions
  let states = [];
  try { states = await haGet('/states', req.haToken); } catch (_) {}

  // Load HA-stored Browser Mod sessions (written by HA automation — survives Node restarts)
  // Format: input_text.smt_session_<username> = "hash|user_agent|timestamp"
  const haStoredSessions = {};
  states
    .filter(s => s.entity_id.startsWith('input_text.smt_session_') && s.state && s.state.includes('|'))
    .forEach(s => {
      const parts    = s.state.split('|');
      const hash     = parts[0];
      const ua       = parts[1];
      const savedAt  = parts[2];
      if (!ua || ua === 'unavailable') return;
      const parsed   = haWS.parseUserAgent(ua);
      // Map username (from entity_id) to session data
      const uKey = s.entity_id.replace('input_text.smt_session_', '');
      haStoredSessions[uKey] = { hash, user_agent: ua, saved_at: savedAt, ...parsed };
    });

  // Build: user_id -> { name, device_name, device_type, device_model }
  const userDeviceMap = {};

  // Step 1: Map person.* user_id -> person name
  states
    .filter(s => s.entity_id.startsWith('person.') && s.attributes && s.attributes.user_id)
    .forEach(s => {
      const uid        = s.attributes.user_id;
      const personName = s.attributes.friendly_name || s.entity_id.replace('person.', '');
      knownUserIds[uid] = personName;
      userDeviceMap[uid] = { name: personName, device_name: null, device_type: null, device_model: null };
    });

  // Step 2: Scan device_tracker.* entities — their friendly_name IS the device name
  // e.g. device_tracker.idevice -> friendly_name: "AbdKanash iPhone"
  // Cross-reference: find which user_id owns this device by matching name prefixes
  const deviceTrackers = states.filter(s => s.entity_id.startsWith('device_tracker.'));
  deviceTrackers.forEach(dt => {
    const dtName  = (dt.attributes && dt.attributes.friendly_name) || '';
    const battLvl = dt.attributes && dt.attributes.battery_level;
    if (!dtName) return;

    // Try to match to a known user by name token overlap
    Object.entries(userDeviceMap).forEach(([uid, info]) => {
      const personName = (info.name || '').toLowerCase();
      const dtNameLow  = dtName.toLowerCase();
      // Check if device name contains person name token or vice versa
      const personTokens = personName.split(/[^a-z0-9]+/).filter(t => t.length >= 3);
      const nameMatch = personTokens.some(t => dtNameLow.includes(t));
      if (!nameMatch) return;

      // Detect platform from device name
      let dtype = 'app', dname = dtName;
      if (/iphone|ipad|ios/i.test(dtName)) dtype = 'ios';
      else if (/android|samsung|galaxy|sm-/i.test(dtName)) dtype = 'android';

      // Find app version sensor for this device
      const namePrefix = dtName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
      const allSensors = states.filter(s => {
        const eid = s.entity_id.toLowerCase().replace(/[^a-z0-9_]/g, '');
        return eid.includes(namePrefix.slice(0, 6));
      });
      const appVerSensor = allSensors.find(s => /app_version/.test(s.entity_id));
      const appVersion   = appVerSensor && appVerSensor.state !== 'unavailable' ? appVerSensor.state : null;

      // Get android model from SM-XXXX pattern in entity IDs
      let deviceModel = appVersion ? 'HA App v' + appVersion : null;
      const androidModel = allSensors.map(s => s.entity_id).join(' ').match(/sm[_-]([a-z0-9]+)/i);
      if (androidModel) deviceModel = 'SM-' + androidModel[1].toUpperCase() + (appVersion ? ' · v' + appVersion : '');

      info.device_name  = dtName;
      info.device_type  = dtype;
      info.device_model = deviceModel;
      if (battLvl !== undefined) info.battery = battLvl;
    });

    // Cache device tracker info by friendly name for quick lookup
    deviceTrackerCache[dtName] = {
      entity_id: dt.entity_id,
      battery:   dt.attributes && dt.attributes.battery_level,
      state:     dt.state,
    };
  });

  // Step 3: For users without person entity link, try matching via knownUserIds
  Object.entries(knownUserIds).forEach(([uid, name]) => {
    if (!userDeviceMap[uid]) {
      userDeviceMap[uid] = { name, device_name: null, device_type: 'app', device_model: null };
    }
    // If still no device found, scan device_tracker by name match
    if (!userDeviceMap[uid].device_name) {
      const nameLow = name.toLowerCase().replace(/[^a-z0-9]/g, '');
      const matched = Object.entries(deviceTrackerCache).find(([dtName]) => {
        const dtLow = dtName.toLowerCase().replace(/[^a-z0-9]/g, '');
        return dtLow.includes(nameLow.slice(0, 6)) || nameLow.includes(dtLow.slice(0, 6));
      });
      if (matched) {
        const [dtName, dtInfo] = matched;
        userDeviceMap[uid].device_name = dtName;
        userDeviceMap[uid].device_type = /iphone|ipad/i.test(dtName) ? 'ios' : /android|sm-/i.test(dtName) ? 'android' : 'app';
      }
    }
  });

  // Step 4: Fallback — for the known smt_admin user ID, directly match AbdKanash iPhone
  // This handles cases where person entity is not linked to HA user
  Object.entries(userDeviceMap).forEach(([uid, info]) => {
    if (info.device_name) return; // already resolved
    // Try direct device tracker name match using just the UID prefix as hint
    const nameHint = (info.name || '').toLowerCase().split(/[^a-z]+/)[0];
    if (!nameHint || nameHint.length < 3) return;
    const matched = states.find(s =>
      s.entity_id.startsWith('device_tracker.') &&
      (s.attributes && s.attributes.friendly_name || '').toLowerCase().includes(nameHint)
    );
    if (matched) {
      const dtName = (matched.attributes && matched.attributes.friendly_name) || matched.entity_id;
      info.device_name = dtName;
      info.device_type = /iphone|ipad/i.test(dtName) ? 'ios' : 'app';
      // Find app version
      const namePrefix = dtName.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,8);
      const appVS = states.find(s => /app_version/.test(s.entity_id) && s.entity_id.toLowerCase().includes(namePrefix.slice(0,6)));
      if (appVS && appVS.state !== 'unavailable') info.device_model = 'HA App v' + appVS.state;
    }
  });

  try {
    const since = new Date(Date.now() - Number(hours) * 3600000).toISOString();
    const lb = await haGet('/logbook/' + since, req.haToken);
    if (!Array.isArray(lb)) return res.json([]);

    let i = 0;
    for (const e of lb) {
      i++;
      const dom = e.domain || (e.entity_id || '').split('.')[0] || '';

      // Only controllable device domains
      const deviceDomains = ['light', 'switch', 'cover', 'lock', 'climate', 'fan',
        'media_player', 'vacuum', 'input_boolean', 'scene', 'button', 'number'];
      if (!deviceDomains.includes(dom)) return;
      // Skip automation/script triggers — only log actual device state changes
      if (dom === 'automation' || dom === 'script') return;
      if (domain && dom !== domain) return;

      const ctx = parseContext(e);
      const classified = classifyEntry(e);
      // Convert to GMT+3 (Amman, Jordan)
      const ts = e.when
        ? new Date(new Date(e.when).getTime() + 3*3600000).toISOString().slice(0, 19).replace('T', ' ')
        : now;

      // Cross-reference with WebSocket action log for browser/platform details
      // context_id links the logbook entry to the WS event
      const ctxId = e.context_id || null;
      const wsEntry = ctxId ? haWS.findContextById(ctxId) : null;

      // Resolve user name
      let userName = null;
      if (ctx.user_id) {
        userName = knownUserIds[ctx.user_id] || null;
        // Try prefix match from lookup table
        if (!userName) {
          const uid8 = ctx.user_id.slice(0, 8).toLowerCase();
          Object.entries(userLookup).forEach(([k, v]) => {
            if (k.startsWith('name:') && uid8.startsWith(k.slice(5).slice(0, 4))) userName = v;
          });
        }
      }

      // First check WebSocket log for real-time browser/platform info
      let detectedPlatform = ctx.platform;
      let deviceSource = null;
      let deviceModel  = null;
      let deviceName   = null;
      let wsPlatform   = null;
      let wsUserAgent  = null;
      let wsBrowser    = null;

      // Resolve user display name
      const resolvedUserName = knownUserIds[ctx.user_id]
        || (userDeviceMap[ctx.user_id] && userDeviceMap[ctx.user_id].name)
        || userName || null;

      // Check persistent cache first — once resolved, never re-resolve
      const cacheKey = e.context_id || (ts + '_' + (e.entity_id || ''));
      const cached   = cacheKey ? resolvedCache[cacheKey] : null;

      // ── Session resolution — 4-layer chain ────────────────────────────────
      // Layer 1: disk cache (context_id already resolved in a previous request)
      // Layer 2: live WebSocket browserDevices{} (Node running, user navigated recently)
      // Layer 3: HA input_text helpers (written by HA automation every navigation)
      // Layer 4: HA history API — Browser Mod sensor state history (covers offline gap)
      let bmSession = null;
      if (!cached) {
        // Layer 2 — live WS
        bmSession = haWS.findSessionByUser(resolvedUserName);

        // Layer 3 — HA input_text (survives Node restarts, written by HA automation)
        if (!bmSession && resolvedUserName) {
          const uKey   = (resolvedUserName || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
          const haSess = haStoredSessions[uKey] || haStoredSessions[uKey.replace(/_+/g,'_')];
          if (haSess) {
            bmSession = {
              user_agent: haSess.user_agent,
              platform:   haSess.platform,
              browser:    haSess.browser,
              is_mobile:  haSess.is_mobile,
              is_ha_app:  haSess.is_ha_app,
              hash:       haSess.hash,
              id:         haSess.hash,
              source:     'ha_input_text',
            };
          }
        }

        // Layer 4 — HA history API (exact platform at exact action time)
        // This resolves the "Node was offline for 2 days" problem.
        // Queries Browser Mod sensor state history and finds the session
        // active at the EXACT timestamp of this action.
        if (!bmSession && resolvedUserName && e.when) {
          try {
            const hist = await sessionHist.resolveSessionAtTime(
              HA_URL, req.haToken, resolvedUserName, e.when, Number(hours)
            );
            if (hist) {
              bmSession = {
                user_agent: hist.ua,
                platform:   hist.platform,
                browser:    hist.browser,
                is_mobile:  hist.is_mobile,
                is_ha_app:  hist.is_ha_app,
                hash:       hist.hash,
                id:         hist.hash,
                source:     'ha_history',
              };
            }
          } catch(histErr) {
            console.warn('[SessionHistory] resolve error:', histErr.message);
          }
        }
      }

      if (bmSession && bmSession.user_agent) {
        // Browser Mod gave us the real user agent
        const parsed    = haWS.parseUserAgent(bmSession.user_agent);
        wsPlatform      = parsed.platform;
        wsBrowser       = parsed.browser;
        wsUserAgent     = bmSession.user_agent;
        deviceSource    = parsed.platform;
        deviceModel     = parsed.browser;
        detectedPlatform = parsed.is_mobile ? 'mobile' : 'desktop';
      } else if (wsEntry && wsEntry.user_agent) {
        // Fallback: WS action log entry has user_agent
        const parsed    = haWS.parseUserAgent(wsEntry.user_agent);
        wsPlatform      = parsed.platform;
        wsBrowser       = parsed.browser;
        wsUserAgent     = wsEntry.user_agent;
        deviceSource    = parsed.platform;
        deviceModel     = parsed.browser;
        detectedPlatform = parsed.is_mobile ? 'mobile' : 'desktop';
      }

      // Fall back to device map if Browser Mod session not found
      if (!deviceSource && ctx.user_id) {
        const devInfo = userDeviceMap[ctx.user_id];
        if (devInfo) {
          deviceName  = devInfo.device_name;
          deviceModel = devInfo.device_model;
          if (devInfo.device_type === 'ios') {
            deviceSource    = devInfo.device_name || 'iPhone (iOS App)';
            detectedPlatform = 'mobile';
          } else if (devInfo.device_type === 'android') {
            deviceSource    = devInfo.device_name || 'Android (HA App)';
            detectedPlatform = 'mobile';
          } else {
            deviceSource    = 'HA App / Browser';
            detectedPlatform = 'app';
          }
        } else {
          // user_id exists but no device found — still a manual action
          deviceSource    = 'HA App / Browser';
          detectedPlatform = 'app';
        }
      }

      entries.push({
        id:           'dev_' + i,
        timestamp:    ts,
        entity_id:    e.entity_id   || null,
        entity_name:  e.name        || e.entity_id || dom,
        domain:       dom,
        state:        e.state       || null,
        action:       classified.action,
        action_color: classified.color,
        message:      ([e.name, e.message].filter(Boolean).join(' — ')).slice(0, 300),
        // WHO
        trigger_type:   ctx.trigger_type,
        trigger_label:  ctx.trigger_label,
        user_id:        ctx.user_id,
        user_name:      userName || ctx.trigger_label,
        platform:       detectedPlatform,
        device_source:  deviceSource,
        device_name:    deviceName,
        ws_platform:    cached ? cached.ws_platform    : wsPlatform,
        ws_browser:     cached ? cached.ws_browser     : wsBrowser,
        ws_user_agent:  cached ? cached.ws_user_agent  : wsUserAgent,
        ws_session_id:  cached ? cached.ws_session_id   : bmSession ? bmSession.id   : null,
        ws_session_hash:cached ? cached.ws_session_hash : bmSession ? bmSession.hash  : null,
        // Which layer resolved the session — for debugging
        // 'ws_live' | 'ha_input_text' | 'ha_history' | 'disk_cache' | null
        session_source: cached ? 'disk_cache' : bmSession ? (bmSession.source || 'ws_live') : null,
        device_model:   deviceModel,
        // WHAT
        service:        ctx.service,
        source:         ctx.source,
        // AUTOMATION context
        automation_name:   ctx.automation_name,
        automation_entity: ctx.automation_entity,
        automation_msg:    ctx.automation_msg,
        // CASCADE context
        context_id:          e.context_id || cacheKey,
        context_entity_id:   ctx.context_entity_id,
        context_entity_name: ctx.context_entity_name,
      });
    } // end for...of lb
  } catch (e) {
    console.warn('device log error:', e.message);
    return res.status(502).json({ error: e.message });
  }

  // Save newly resolved entries to persistent disk cache
  let newResolutions = 0;
  entries.forEach(entry => {
    if (!entry.context_id) return;
    if (!resolvedCache[entry.context_id] && (entry.ws_platform || entry.device_name)) {
      resolvedCache[entry.context_id] = {
        ws_platform:    entry.ws_platform,
        ws_browser:     entry.ws_browser,
        ws_user_agent:  entry.ws_user_agent,
        ws_session_id:  entry.ws_session_id,
        ws_session_hash:entry.ws_session_hash,
        platform:       entry.platform,
        device_source:  entry.device_source,
        device_name:    entry.device_name,
        device_model:   entry.device_model,
        session_source: entry.session_source,
      };
      newResolutions++;
    }
  });
  if (newResolutions > 0) {
    console.log('[Cache] Saved', newResolutions, 'new entries. Total:', Object.keys(resolvedCache).length);
    saveCache();
  }

  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  res.json(entries.slice(0, Number(limit)));
});



// ── Read HA-stored Browser Mod sessions (persistent across Node.js restarts) ──
// HA automation writes browser session data to input_text.smt_session_<username>
// This endpoint reads those values — data survives even if Node is down for weeks
app.get('/api/ha-sessions', requireToken, async (req, res) => {
  try {
    const states = await haGet('/states', req.haToken);
    const sessionEntities = states.filter(s =>
      s.entity_id.startsWith('input_text.smt_session_')
    );

    const sessions = sessionEntities.map(s => {
      const parts   = (s.state || '').split('|');
      const hash    = parts[0] || null;
      const ua      = parts[1] || null;
      const savedAt = parts[2] || null;
      const parsed  = ua ? haWS.parseUserAgent(ua) : null;
      const userName = s.entity_id
        .replace('input_text.smt_session_', '')
        .replace(/_/g, ' ')
        .replace(/\w/g, l => l.toUpperCase());
      return {
        entity_id: s.entity_id,
        user_name: userName,
        hash,
        user_agent: ua,
        saved_at:  savedAt,
        platform:  parsed ? parsed.platform : null,
        browser:   parsed ? parsed.browser  : null,
        icon:      parsed ? parsed.icon     : null,
        is_mobile: parsed ? parsed.is_mobile: false,
      };
    }).filter(s => s.hash && s.user_agent);

    res.json(sessions);
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
});

// ── Session History — debug + cache control ───────────────────────────────────
// GET /api/session-history?hours=48
// Returns the full session timeline built from HA Browser Mod sensor history.
// Use this to verify historical resolution is working correctly.
app.get('/api/session-history', requireToken, async (req, res) => {
  const { hours = 48, invalidate } = req.query;
  if (invalidate === '1') sessionHist.invalidateCache();
  try {
    const timeline = await sessionHist.getTimeline(HA_URL, req.haToken, Number(hours));
    const summary  = {};
    Object.entries(timeline).forEach(([user, entries]) => {
      summary[user] = entries.map(e => ({
        hash:     e.hash,
        platform: e.platform,
        browser:  e.browser,
        from:     new Date(e.from_ts).toISOString(),
        until:    e.until_ts ? new Date(e.until_ts).toISOString() : 'active',
      }));
    });
    res.json({ hours: Number(hours), users: Object.keys(timeline).length, timeline: summary });
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
});

// POST /api/session-history/invalidate — force rebuild on next request
app.post('/api/session-history/invalidate', requireToken, (req, res) => {
  sessionHist.invalidateCache();
  res.json({ ok: true, message: 'Session history cache invalidated. Will rebuild on next request.' });
});

// GET /api/session-history/resolve?user=smt_admin&timestamp=2026-06-04T10:38:00
// Test historical resolution for a specific user + time — for debugging
app.get('/api/session-history/resolve', requireToken, async (req, res) => {
  const { user, timestamp, hours = 48 } = req.query;
  if (!user || !timestamp) return res.status(400).json({ error: 'user and timestamp required' });
  try {
    const result = await sessionHist.resolveSessionAtTime(
      HA_URL, req.haToken, user, timestamp, Number(hours)
    );
    res.json({ user, timestamp, resolved: result || null, found: !!result });
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
});

// ── Keep generic /api/logs as alias for system log ──────────────────────────
app.get('/api/logs', requireToken, async (req, res) => {
  req.url = '/api/logs/system' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
  res.redirect(307, '/api/logs/system' + (Object.keys(req.query).length ? '?' + new URLSearchParams(req.query) : ''));
});


app.get('/api/logs/history/:entityId', requireToken, async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const data = await haGet(
      `/history/period/${since}?filter_entity_id=${req.params.entityId}&minimal_response`,
      req.haToken
    );
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});


// ── CONNECTED DEVICES — full profile from companion app sensors ───────────────
// Discovers all devices registered in HA via sensor entity naming patterns
// e.g. sensor.abdkanash_iphone_battery_state -> device "AbdKanash iPhone"
app.get('/api/connected-devices', requireToken, async (req, res) => {
  try {
    const states = await haGet('/states', req.haToken);

    // Group entities by device prefix
    // Pattern: sensor.<prefix>_<sensor_type>
    // Known suffixes to strip to get device name
    const SENSOR_SUFFIXES = [
      'battery_state','battery_level','charger_type','ssid','bssid',
      'connection_type','sim_1','sim_2','app_version','audio_output',
      'location_permission','last_update_trigger','geocoded_location',
      'focus','activity','steps','storage','total_storage'
    ];

    const deviceMap = {};

    states.forEach(s => {
      if (!s.entity_id.startsWith('sensor.') &&
          !s.entity_id.startsWith('binary_sensor.') &&
          !s.entity_id.startsWith('device_tracker.') &&
          !s.entity_id.startsWith('notify.')) return;

      const name = (s.attributes && s.attributes.friendly_name) || '';
      if (!name) return;

      // Strip known sensor suffixes from friendly name to get device name
      let deviceName = name;
      for (const suffix of SENSOR_SUFFIXES) {
        const suffixTitle = suffix.replace(/_/g, ' ');
        const regex = new RegExp('\\s+' + suffixTitle + '$', 'i');
        deviceName = deviceName.replace(regex, '').trim();
      }
      // Also strip trailing state/sensor words
      deviceName = deviceName
        .replace(/\s+(Battery State|Battery state|SSID|BSSID|Connection Type|Last Update Trigger|Focus|App Version|Audio Output|Location permission|Charger type|geocoded location|SIM \d)$/i, '')
        .trim();

      if (!deviceName || deviceName === name.trim()) return;
      if (deviceName.length < 3) return;

      if (!deviceMap[deviceName]) {
        deviceMap[deviceName] = {
          name: deviceName,
          entities: [],
          sensors: {},
          platform: null,
          online: false,
          last_seen: null,
        };
      }

      const dev = deviceMap[deviceName];
      dev.entities.push(s.entity_id);

      // Detect platform
      if (/iphone|ios/i.test(name) || /iphone/i.test(s.entity_id)) dev.platform = 'ios';
      else if (/android|samsung|galaxy|sm_s|huawei|pixel/i.test(name) || /sm_s|android/i.test(s.entity_id)) dev.platform = 'android';
      else if (/laptop|desktop|pc|mac|windows|linux/i.test(name)) dev.platform = 'desktop';
      else if (!dev.platform) dev.platform = 'app';

      // Extract sensor values
      const eid = s.entity_id;
      const val = s.state;
      const attr = s.attributes || {};

      if (/battery_state|battery_level/.test(eid)) {
        dev.sensors.battery_state = val;
        dev.sensors.battery_level = attr.battery_level || val;
      }
      if (/charger_type/.test(eid)) dev.sensors.charger_type = val;
      if (/ssid/.test(eid) && !/bssid/.test(eid)) dev.sensors.ssid = val;
      if (/bssid/.test(eid)) dev.sensors.bssid = val;
      if (/connection_type/.test(eid)) dev.sensors.connection_type = val;
      if (/app_version/.test(eid)) dev.sensors.app_version = val;
      if (/last_update_trigger/.test(eid)) dev.sensors.last_trigger = val;
      if (/geocoded_location/.test(eid)) dev.sensors.location = val;
      if (/audio_output/.test(eid)) dev.sensors.audio = val;
      if (/location_permission/.test(eid)) dev.sensors.location_permission = val;
      if (/sim_1/.test(eid)) dev.sensors.sim_1 = val;
      if (/sim_2/.test(eid)) dev.sensors.sim_2 = val;
      if (/focus/.test(eid)) dev.sensors.focus = val;

      // Online status
      if (val !== 'unavailable' && val !== 'unknown') {
        dev.online = true;
      }

      // Last seen from last_changed
      if (s.last_changed) {
        if (!dev.last_seen || s.last_changed > dev.last_seen) {
          dev.last_seen = s.last_changed;
        }
      }

      // Device tracker adds location
      if (eid.startsWith('device_tracker.')) {
        dev.sensors.presence = val; // home / not_home
        if (attr.latitude)  dev.sensors.latitude  = attr.latitude;
        if (attr.longitude) dev.sensors.longitude = attr.longitude;
        if (attr.gps_accuracy) dev.sensors.gps_accuracy = attr.gps_accuracy;
      }
    });

    const devices = Object.values(deviceMap)
      .filter(d => d.entities.length >= 2) // must have at least 2 entities to be a real device
      .sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));

    res.json(devices);
  } catch (e) {
    console.error('connected-devices:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── DEVICE ACTIVITY REPORT — actions by a specific device/user ───────────────
app.get('/api/connected-devices/:deviceName/report', requireToken, async (req, res) => {
  const { hours = 24 } = req.query;
  const deviceName = decodeURIComponent(req.params.deviceName).toLowerCase();

  try {
    // Find user_id associated with this device from person entities + known IDs
    const states = await haGet('/states', req.haToken);
    const matchedUserIds = new Set();

    // Try to match person entities
    states
      .filter(s => s.entity_id.startsWith('person.') && s.attributes && s.attributes.user_id)
      .forEach(s => {
        const pname = (s.attributes.friendly_name || '').toLowerCase();
        if (pname.includes(deviceName.split(' ')[0]) || deviceName.includes(pname.split(' ')[0])) {
          matchedUserIds.add(s.attributes.user_id);
        }
      });

    // Also match from knownUserIds
    Object.entries(knownUserIds).forEach(([uid, uname]) => {
      if (uname.toLowerCase().includes(deviceName.split(' ')[0]) ||
          deviceName.includes(uname.toLowerCase().split(' ')[0])) {
        matchedUserIds.add(uid);
      }
    });

    const since = new Date(Date.now() - Number(hours) * 3600000).toISOString();
    const lb = await haGet('/logbook/' + since, req.haToken);

    const actions = [];
    if (Array.isArray(lb)) {
      lb.forEach((e, i) => {
        const uid = e.context_user_id;
        const evtType = e.context_event_type;

        // Include if: user_id matches OR device name appears in entity names
        const isThisUser = uid && matchedUserIds.has(uid);
        const isCallService = evtType === 'call_service';

        if (!isThisUser || !isCallService) return;

        const ctx = parseContext(e);
        const classified = classifyEntry(e);
        const ts = e.when
          ? new Date(e.when).toISOString().slice(0, 19).replace('T', ' ')
          : '';

        actions.push({
          timestamp:   ts,
          entity_id:   e.entity_id || null,
          entity_name: e.name || e.entity_id || '—',
          domain:      e.domain || (e.entity_id || '').split('.')[0],
          state:       e.state || null,
          action:      classified.action,
          service:     ctx.service,
          user_id:     uid,
          message:     ([e.name, e.state].filter(Boolean).join(' → ')).slice(0, 200),
        });
      });
    }

    // Summary stats
    const summary = {
      total_actions: actions.length,
      by_domain: {},
      by_action: {},
      hours: Number(hours),
      user_ids: [...matchedUserIds],
    };
    actions.forEach(a => {
      summary.by_domain[a.domain] = (summary.by_domain[a.domain] || 0) + 1;
      summary.by_action[a.action] = (summary.by_action[a.action] || 0) + 1;
    });

    res.json({ device: deviceName, summary, actions: actions.slice(0, 500) });
  } catch (e) {
    console.error('device-report:', e.message);
    res.status(502).json({ error: e.message });
  }
});


// ── Security notification ────────────────────────────────────────────────────
app.post('/api/security/notify', requireToken, async (req, res) => {
  const { message, title = 'HA Admin Alert' } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    res.json(await haPost('/services/persistent_notification/create', req.haToken, { message, title }));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ── Security Audit ───────────────────────────────────────────────────────────
app.get('/api/audit', requireToken, async (req, res) => {
  const findings = [];
  let haVersion = 'unknown';
  try {
    try { const cfg = await haGet('/config', req.haToken); haVersion = cfg.version || 'unknown'; } catch (_) {}

    try {
      const states = await haGet('/states', req.haToken);
      const unavailable = states.filter(s => s.state === 'unavailable' || s.state === 'unknown');
      if (unavailable.length > 0) findings.push({
        severity: 'WARNING', category: 'DEVICES',
        title: `${unavailable.length} device(s) unavailable`,
        detail: unavailable.slice(0, 5).map(s => s.entity_id).join(', '),
        action: 'Check Z-Wave/Zigbee mesh and device power'
      });
      const lowBatt = states.filter(s => {
        const b = s.attributes?.battery_level ?? s.attributes?.battery;
        return b !== undefined && Number(b) < 15;
      });
      if (lowBatt.length > 0) findings.push({
        severity: 'WARNING', category: 'DEVICES',
        title: `${lowBatt.length} device(s) critical battery (<15%)`,
        detail: lowBatt.map(s => `${s.entity_id}(${s.attributes.battery_level ?? s.attributes.battery}%)`).join(', '),
        action: 'Replace batteries — security sensors affected'
      });
      const offAutos = states.filter(s => s.entity_id.startsWith('automation.') && s.state === 'off');
      if (offAutos.length > 0) findings.push({
        severity: 'WARNING', category: 'AUTOMATIONS',
        title: `${offAutos.length} automation(s) disabled`,
        detail: offAutos.map(a => a.attributes?.friendly_name || a.entity_id).join(', '),
        action: 'Review and re-enable security-critical automations'
      });
    } catch (_) {}

    // Auth scan via logbook (error_log not available on all HA versions)
    try {
      const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
      const logbook = await haGet('/logbook/' + since, req.haToken);
      if (Array.isArray(logbook)) {
        const authFails = logbook.filter(e =>
          /invalid_auth|login.*fail|auth.*fail/i.test(JSON.stringify(e))
        );
        if (authFails.length > 3) {
          findings.unshift({
            severity: 'CRITICAL', category: 'AUTH',
            title: 'Repeated auth failures detected in logbook (' + authFails.length + ' events)',
            detail: 'Check Settings → System → Logs in HA for full details',
            action: 'Set login_attempts_threshold: 5 and ip_ban_enabled: true in configuration.yaml'
          });
        }
      }
    } catch (_) {}

    const score = Math.max(0,
      100 -
      findings.filter(f => f.severity === 'CRITICAL').length * 25 -
      findings.filter(f => f.severity === 'WARNING').length * 10
    );
    res.json({ haVersion, score, findings, timestamp: new Date().toISOString() });
  } catch (e) { res.status(502).json({ error: e.message }); }
});


// ── WebSocket real-time action log ───────────────────────────────────────────
app.get('/api/ws/actions', requireToken, (req, res) => {
  const { limit = 200, user_id } = req.query;
  let log = haWS.getActionLog();
  if (user_id) log = log.filter(e => e.user_id === user_id);
  res.json({
    connected: haWS.isConnected(),
    count: log.length,
    actions: log.slice(0, Number(limit))
  });
});

app.get('/api/ws/sessions', requireToken, (req, res) => {
  res.json({
    connected: haWS.isConnected(),
    sessions: haWS.getBrowserSessions()
  });
});

// Enrich a logbook entry with WS context by context_id
app.get('/api/ws/context/:contextId', requireToken, (req, res) => {
  const entry = haWS.findContextById(req.params.contextId);
  res.json(entry || { found: false });
});

app.get('/api/ws/status', requireToken, (req, res) => {
  const sessions = haWS.getBrowserSessions();
  res.json({
    connected: haWS.isConnected(),
    action_log_size: haWS.getActionLog().length,
    browser_sessions: sessions.length,
    sessions
  });
});

// Force reload Browser Mod sessions from REST API
app.post('/api/ws/reload-sessions', requireToken, async (req, res) => {
  try {
    const allStates = await haGet('/states', req.haToken);
    const bmStates  = allStates.filter(s => s.entity_id.startsWith('sensor.browser_mod_'));
    haWS.preloadBrowserModStates(bmStates);
    res.json({ ok: true, loaded: bmStates.length, sessions: haWS.getBrowserSessions().length });
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
});

// ── Serve frontend from ../frontend/ ─────────────────────────────────────────
const frontendPath = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendPath));
app.get('/', (_req, res) => res.sendFile(path.join(frontendPath, 'index.html')));

// ── Debug endpoint — tests all HA endpoints ──────────────────────────────
app.get('/api/debug', requireToken, async (req, res) => {
  const results = {};
  const endpoints = [
    ['root',    '/'],
    ['config',  '/config'],
    ['states',  '/states'],
    ['logbook', '/logbook/' + new Date(Date.now()-3600000).toISOString()],
  ];
  for (const [name, path] of endpoints) {
    try {
      const d = await haGet(path, req.haToken);
      results[name] = { ok: true, type: typeof d, len: Array.isArray(d) ? d.length : undefined };
    } catch (e) {
      results[name] = { ok: false, error: e.message };
    }
  }
  res.json(results);
});

app.listen(PORT, () => {
  console.log(`\nHA Admin API  →  http://localhost:${PORT}`);
  console.log(`Frontend      →  http://localhost:${PORT}  (open this in browser)`);
  console.log(`HA target     →  ${HA_URL}`);
  console.log(`Token         →  ${HA_TOKEN ? '✓ set in env' : '✗ pass Authorization header'}\n`);
});