/**
 * ha-ws.js — Home Assistant WebSocket subscriber
 * Handles Browser Mod 2.x entity structure:
 * sensor.browser_mod_<hash>_browser_useragent (state = user agent string)
 * sensor.browser_mod_<hash>_browser_user      (state = username or 'anonymous')
 * sensor.browser_mod_<hash>_browser_path      (state = current dashboard path)
 * sensor.browser_mod_<hash>_browser_id        (state = browser unique ID)
 * sensor.browser_mod_<hash>_browser_width     (state = screen width)
 * sensor.browser_mod_<hash>_browser_height    (state = screen height)
 * sensor.browser_mod_<hash>_browser_visibility(state = visible/hidden)
 * sensor.browser_mod_<hash>_panel             (state = panel name)
 */

const WebSocket = require('ws');

// ── In-memory stores ──────────────────────────────────────────────────────────
const wsActionLog    = [];   // last 1000 call_service events
const browserDevices = {};   // hash -> { id, user_agent, user, path, width, height, platform, browser, last_seen }
const MAX_LOG        = 1000;

let wsClient      = null;
let wsConnected   = false;
let wsMsgId       = 1;
let wsReconnTimer = null;
let haUrl         = '';
let haToken       = '';

// ── Parse user agent string into human-readable platform + browser ─────────────
function parseUserAgent(ua) {
  if (!ua || ua === 'unavailable' || ua === 'unknown') {
    return { platform: 'Unknown', browser: null, icon: 'ti-browser', is_mobile: false, is_ha_app: false };
  }
  const isHAApp   = ua.includes('io.robbie.HomeAssistant') || ua.includes('Home Assistant/');
  const isIOS     = ua.includes('iPhone') || ua.includes('iPad') || ua.includes('iPod');
  const isAndroid = ua.includes('Android');
  const isMobile  = isIOS || isAndroid || ua.includes('Mobile');
  const isWindows = ua.includes('Windows NT');
  const isMac     = ua.includes('Macintosh') && !isIOS;
  const isLinux   = ua.includes('Linux') && !isAndroid && !isIOS;

  // Extract HA app version
  let haVer = null;
  const haMatch = ua.split('Home Assistant/')[1] || ua.split('HomeAssistant/')[1];
  if (haMatch) haVer = haMatch.split(/[ (]/)[0];

  // Browser
  let browser = null;
  if (isHAApp) {
    browser = haVer ? 'HA App v' + haVer : 'HA App';
  } else if (ua.includes('Edg/')) {
    const v = ua.split('Edg/')[1]; browser = 'Edge ' + (v ? v.split('.')[0] : '');
  } else if (ua.includes('OPR/')) {
    const v = ua.split('OPR/')[1]; browser = 'Opera ' + (v ? v.split('.')[0] : '');
  } else if (ua.includes('Firefox/')) {
    const v = ua.split('Firefox/')[1]; browser = 'Firefox ' + (v ? v.split('.')[0] : '');
  } else if (ua.includes('Chrome/')) {
    const v = ua.split('Chrome/')[1]; browser = 'Chrome ' + (v ? v.split('.')[0] : '');
  } else if (ua.includes('Safari/')) {
    browser = 'Safari';
  }

  let platform = 'Desktop Browser', icon = 'ti-device-desktop';
  if      (isHAApp && isIOS)     { platform = 'iPhone HA App';    icon = 'ti-brand-apple'; }
  else if (isHAApp && isAndroid) { platform = 'Android HA App';   icon = 'ti-brand-android'; }
  else if (isHAApp)              { platform = 'HA Mobile App';    icon = 'ti-device-mobile'; }
  else if (isIOS)                { platform = 'iPhone Browser';   icon = 'ti-brand-apple'; }
  else if (isAndroid)            { platform = 'Android Browser';  icon = 'ti-brand-android'; }
  else if (isWindows)            { platform = 'Windows Browser';  icon = 'ti-device-desktop'; }
  else if (isMac)                { platform = 'Mac Browser';      icon = 'ti-device-laptop'; }
  else if (isLinux)              { platform = 'Linux Browser';    icon = 'ti-device-desktop'; }

  return { platform, browser: browser ? browser.trim() : null, icon, is_mobile: isMobile, is_ha_app: isHAApp };
}// ── Extract browser hash from entity ID ──────────────────────────────────────
// sensor.browser_mod_65693587_f96499c0_browser_useragent -> 65693587_f96499c0
function extractHash(entityId) {
  const m = entityId.match(/^sensor\.browser_mod_([a-f0-9_]+)_browser_/);
  return m ? m[1] : null;
}

// ── Update browser device record from a state_changed event ──────────────────
function updateBrowserDevice(entityId, state) {
  const hash = extractHash(entityId);
  if (!hash) return;

  if (!browserDevices[hash]) {
    browserDevices[hash] = {
      hash, id: null, user: null, user_agent: null,
      path: null, width: null, height: null,
      platform: 'Unknown', browser: 'Unknown', icon: 'ti-browser',
      is_mobile: false, is_ha_app: false, last_seen: null, visibility: null
    };
  }

  const dev = browserDevices[hash];
  dev.last_seen = new Date().toISOString();

  if (entityId.endsWith('_browser_useragent') || entityId.endsWith('_browser_userAgent')) {
    dev.user_agent = state;
    const parsed = parseUserAgent(state);
    dev.platform   = parsed.platform;
    dev.browser    = parsed.browser;
    dev.icon       = parsed.icon;
    dev.is_mobile  = parsed.is_mobile;
    dev.is_ha_app  = parsed.is_ha_app;
    console.log('[WS] Browser device updated:', hash, '→', parsed.platform, '|', parsed.browser);
  }
  else if (entityId.endsWith('_browser_user')) {
    dev.user = (state && state !== 'unavailable' && state.toLowerCase() !== 'anonymous') ? state : null;
  }
  else if (entityId.endsWith('_browser_path')) {
    dev.path = state;
  }
  else if (entityId.endsWith('_browser_id')) {
    dev.id = state;
  }
  else if (entityId.endsWith('_browser_width')) {
    dev.width = state;
  }
  else if (entityId.endsWith('_browser_height')) {
    dev.height = state;
  }
  else if (entityId.endsWith('_browser_visibility')) {
    dev.visibility = state; // 'visible' or 'hidden'
  }
  else if (entityId.endsWith('_panel')) {
    dev.panel = state;
  }
}

// ── Find browser session by user_id (via username match) ─────────────────────
// Match session by user name — STRICT: exact username match only, valid UA required
function findSessionByUser(userName) {
  if (!userName) return null;
  const uLow = userName.toLowerCase().replace(/[^a-z0-9]/g, '');
  // Only sessions with real user_agent (private/incognito = unavailable, skip them)
  const validSessions = Object.values(browserDevices).filter(d =>
    d.user_agent && d.user_agent !== 'unavailable' && d.user && d.user !== 'null'
  );
  // Must be EXACT match on session.user — never partial cross-user match
  return validSessions.find(d =>
    d.user.toLowerCase().replace(/[^a-z0-9]/g, '') === uLow
  ) || null;
}

// Match session by action timestamp — picks the session most recently active before the action
// This handles private/incognito by returning null instead of a wrong session
function findSessionByUserAndTime(userName, actionTimestamp) {
  if (!userName) return null;
  const uLow      = userName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const actionTs  = new Date(actionTimestamp).getTime();
  const validSessions = Object.values(browserDevices).filter(d =>
    d.user_agent && d.user_agent !== 'unavailable' && d.user && d.user !== 'null'
  );
  // Exact user match only
  const userSessions = validSessions.filter(d =>
    d.user.toLowerCase().replace(/[^a-z0-9]/g, '') === uLow
  );
  if (!userSessions.length) return null;
  // Pick session whose last_seen is closest to (and before) the action time
  // within a 5-minute window — if no match, return null (private mode)
  const WINDOW_MS = 5 * 60 * 1000;
  const candidates = userSessions.filter(d => {
    const sessionTs = new Date(d.last_seen).getTime();
    const diff = actionTs - sessionTs;
    return diff >= -30000 && diff <= WINDOW_MS; // -30s to +5min
  });
  if (!candidates.length) return null;
  // Return closest in time
  return candidates.sort((a, b) => {
    const da = Math.abs(actionTs - new Date(a.last_seen).getTime());
    const db = Math.abs(actionTs - new Date(b.last_seen).getTime());
    return da - db;
  })[0];
}

function findSessionByUserId(userId, knownIds) {
  if (!userId) return null;
  const userName = knownIds[userId];
  if (!userName) return null;
  return findSessionByUser(userName);
}

// ── WebSocket connection ──────────────────────────────────────────────────────
function connectWS(url, token) {
  haUrl   = url;
  haToken = token;
  if (wsClient) { try { wsClient.terminate(); } catch(_) {} }
  if (wsReconnTimer) { clearTimeout(wsReconnTimer); wsReconnTimer = null; }

  const wsUrl = url.replace(/^http/, 'ws') + '/api/websocket';
  console.log('[WS] Connecting to', wsUrl);

  wsClient = new WebSocket(wsUrl, { rejectUnauthorized: false });

  wsClient.on('open', () => console.log('[WS] Socket open'));

  wsClient.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch(_) { return; }

    if (msg.type === 'auth_required') {
      wsClient.send(JSON.stringify({ type: 'auth', access_token: haToken }));
      return;
    }

    if (msg.type === 'auth_ok') {
      wsConnected = true;
      console.log('[WS] Authenticated. Subscribing to events...');
      wsClient.send(JSON.stringify({ id: wsMsgId++, type: 'subscribe_events', event_type: 'call_service' }));
      wsClient.send(JSON.stringify({ id: wsMsgId++, type: 'subscribe_events', event_type: 'state_changed' }));

      // Load existing browser_mod states immediately
      wsClient.send(JSON.stringify({ id: wsMsgId++, type: 'get_states' }));
      return;
    }

    if (msg.type === 'auth_invalid') {
      console.error('[WS] Auth failed');
      return;
    }

    // Initial states load
    if (msg.type === 'result' && msg.success && Array.isArray(msg.result)) {
      msg.result
        .filter(s => s.entity_id && s.entity_id.startsWith('sensor.browser_mod_'))
        .forEach(s => updateBrowserDevice(s.entity_id, s.state));
      console.log('[WS] Loaded', Object.keys(browserDevices).length, 'browser session(s)');
      return;
    }

    if (msg.type !== 'event') return;
    const evt  = msg.event || {};
    const data = evt.data || {};

    // ── call_service ─────────────────────────────────────────────────────────
    if (evt.event_type === 'call_service') {
      const ctx    = data.context || {};
      const domain = data.domain  || '';
      const svc    = data.service || '';
      const tracked = ['light','switch','cover','lock','climate','fan',
                       'media_player','vacuum','input_boolean','scene','script','button'];
      if (!tracked.includes(domain)) return;

      const userId   = ctx.user_id || null;
      const svcData  = data.service_data || {};
      const entityId = Array.isArray(svcData.entity_id)
        ? svcData.entity_id[0] : (svcData.entity_id || null);

      const entry = {
        id:         ctx.id || (Date.now() + '_' + Math.random().toString(36).slice(2,6)),
        timestamp:  evt.time_fired || new Date().toISOString(),
        user_id:    userId,
        domain,
        service:    svc,
        entity_id:  entityId,
        context_id: ctx.id || null,
        // Browser info — resolved at query time
      };

      wsActionLog.unshift(entry);
      if (wsActionLog.length > MAX_LOG) wsActionLog.pop();
    }

    // ── state_changed — track browser_mod sensors ─────────────────────────
    if (evt.event_type === 'state_changed') {
      const eid      = data.entity_id || '';
      const newState = data.new_state;
      if (!eid.startsWith('sensor.browser_mod_') || !newState) return;
      updateBrowserDevice(eid, newState.state);
    }
  });

  wsClient.on('close', () => {
    wsConnected = false;
    console.log('[WS] Disconnected — reconnecting in 15s');
    wsReconnTimer = setTimeout(() => connectWS(haUrl, haToken), 15000);
  });

  wsClient.on('error', err => console.warn('[WS] Error:', err.message));
}

function disconnectWS() {
  if (wsReconnTimer) clearTimeout(wsReconnTimer);
  if (wsClient) { try { wsClient.terminate(); } catch(_) {} }
  wsConnected = false;
}

// ── Pre-load Browser Mod states from REST API (called on connect) ─────────────
// Each Browser Mod sensor is a separate entity:
// sensor.browser_mod_<hash>_browser_useragent -> state = user agent string
// sensor.browser_mod_<hash>_browser_user      -> state = username
// etc.
function preloadBrowserModStates(states) {
  states.forEach(s => {
    if (s.entity_id && s.entity_id.startsWith('sensor.browser_mod_')) {
      updateBrowserDevice(s.entity_id, s.state);
    }
  });
  console.log('[WS] Pre-loaded', Object.keys(browserDevices).length, 'browser session(s) from REST');
}

// ── Public API ────────────────────────────────────────────────────────────────
module.exports = {
  connectWS,
  disconnectWS,
  isConnected:        () => wsConnected,
  getActionLog:       () => wsActionLog,
  getBrowserSessions: () => Object.values(browserDevices),
  findContextById:    (ctxId) => wsActionLog.find(e => e.context_id === ctxId) || null,
  findSessionByUser,
  findSessionByUserId,
  findSessionByUserAndTime,
  preloadBrowserModStates,
  parseUserAgent,
};