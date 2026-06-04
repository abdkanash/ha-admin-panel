# HA Admin Panel — Changelog

---

## v2.0.0 — 2026-06-04

### New: Historical Session Resolution (Layer 4)

The core problem solved in v2: when Node.js is offline for hours or days,
actions logged by HA during that gap had no platform/browser data because
the Browser Mod session was no longer in memory. v2 fixes this permanently.

#### New file: `ha-session-history.js`

A dedicated module that queries the HA history API to reconstruct past
Browser Mod sessions. Instead of guessing which device a user was on,
Node now looks up the exact session that was active at the action timestamp.

Key behaviors:
- Queries `/api/history/period/` for all known Browser Mod hashes in one
  batched HTTP request — no per-entry API calls
- Builds a session timeline per user: `{ hash, ua, platform, from_ts, until_ts }`
- Covers up to 90 days of history (requires recorder config below)
- In-memory cache with 5-minute TTL — timeline is built once per request window
- Auto-discovers new device hashes via live HA states on each rebuild
- 30-minute gap tolerance: if a session ended just before an action, still uses it

#### Updated: `server.js` — 4-layer resolution chain

Each logbook entry now resolves platform/browser through four ordered layers,
stopping at the first that returns a result:

| Layer | Source | Covers |
|-------|--------|--------|
| 1 | Disk cache (`resolution_cache.json`) | context_ids resolved in previous requests |
| 2 | Live WebSocket (`browserDevices{}`) | Actions while Node is running |
| 3 | HA `input_text.smt_session_*` helpers | Latest known session per user |
| 4 | HA history API (new in v2) | Any action while Node was offline |

When Layer 4 resolves an entry, it is immediately written to the disk cache
(Layer 1) so subsequent requests never re-query HA history for the same event.

#### New field: `session_source`

Every device log entry now includes a `session_source` field indicating which
layer resolved the session:

- `ws_live` — resolved from live WebSocket session in memory
- `ha_input_text` — resolved from HA automation-written helper
- `ha_history` — resolved from HA Browser Mod sensor history
- `disk_cache` — resolved from persistent `resolution_cache.json`
- `null` — no session data available (private/incognito or unknown user)

#### New endpoints

```
GET  /api/session-history?hours=48
     Returns the full session timeline built from HA history.
     Add ?invalidate=1 to force a cache rebuild.

GET  /api/session-history/resolve?user=smt_admin&timestamp=2026-06-04T10:38:00
     Test resolution for a specific user and timestamp. Use this to verify
     historical data is being read correctly after Node restarts.

POST /api/session-history/invalidate
     Force the session timeline cache to rebuild on the next request.
     Call this after adding a new device or changing known hashes.
```

#### Required HA configuration

Add to `configuration.yaml` and restart HA:

```yaml
recorder:
  purge_keep_days: 90
  include:
    entity_globs:
      - sensor.browser_mod_*
      - light.*
      - switch.*
      - lock.*
      - cover.*
      - climate.*
      - fan.*
      - media_player.*
      - vacuum.*
      - input_boolean.*
      - scene.*
      - button.*
      - automation.*
      - script.*
      - person.*
      - device_tracker.*
```

Without this, HA purges Browser Mod history after 10 days (default).
Setting 90 days means Node can resolve sessions from up to 3 months ago.

#### Internal: `forEach` → `for...of` in device log endpoint

The logbook processing loop was changed from `lb.forEach()` to `for...of`
to allow `await` inside the loop body (required for Layer 4 async calls).
No behavior change for Layers 1–3.

---

## v1.0.0 — 2026-06-03

### Initial release

#### Architecture

- Node.js + Express backend at `http://localhost:3001`
- Single HTML frontend served by the backend
- Connects to HA at `http://192.168.104.102:8123` and Nabu Casa remote URL
- All HA data via REST API + WebSocket

#### Features

**Overview tab**
- Live entity metrics: total, unavailable, low battery, automations, domains
- Alert banner when unavailable > 3 or low battery > 2
- Threat surface bars (device coverage, battery health, integration count)
- Live auth log (last 25 system events)

**Audit tab**
- Security score (0–100) based on unavailable devices, low battery, disabled automations
- Findings list with severity (CRITICAL / WARNING), detail, and recommended action
- System info panel (HA version, timezone, location, config dir)

**Users tab**
- People and device trackers from HA states
- Auth log events from logbook (auth/login/token keywords)
- Link to HA profile for token management

**Devices tab**
- Full entity registry with domain/state/search filters
- Click-to-expand device detail panel with attributes and 24h state history
- Turn on/off controls for lights, switches, input_booleans
- Lock/unlock controls for lock entities

**Connected Devices tab**
- Companion app device discovery via sensor entity naming patterns
- Device profile: battery, WiFi SSID, app version, presence, SIM, audio, focus
- Activity report per device (logbook actions filtered by matched user_id)

**Automations tab**
- Automation health list: last triggered, mode, state
- Run and enable/disable controls per automation

**Logs tab — System Log**
- Logbook + unavailable states + low battery anomalies
- CRITICAL / WARNING / INFO levels with component and message
- Click-to-expand detail row with full context fields
- Filter by level, hours, and search term

**Logs tab — Auth Log**
- Logbook entries filtered to auth/login/token/user keywords
- SUCCESS / FAILED / LOGOUT / INFO result tags

**Logs tab — Device Actions**
- Logbook filtered to controllable device domains
- Expandable rows with full who/when/how context
- Trigger type classification: MANUAL / AUTOMATION / WEBHOOK / CASCADE / PHYSICAL
- Platform badge: Windows Browser / iPhone HA App / Android / Wall Switch / etc.

**Logs tab — Live Sessions**
- Real-time Browser Mod session viewer (requires Browser Mod installed in HA)
- Per-session: user, platform, browser, visibility, path, screen size, user agent

#### 3-layer session resolution (v1)

| Layer | Source |
|-------|--------|
| 1 | Disk cache (`resolution_cache.json`) |
| 2 | Live WebSocket (`browserDevices{}`) |
| 3 | HA `input_text.smt_session_*` helpers |

#### HA-side setup (completed during v1)

- Browser Mod installed via HACS, sensors confirmed active
- `input_text` helpers created for all 5 users (clean entity IDs)
- Automation `smt_admin_save_browser_session` — triggers on `browser_path`
  changes for active hashes, writes `hash|user_agent|timestamp` to the
  matching helper on every dashboard navigation
- Verified writing: both `smt_session_smt_admin` and
  `smt_session_abdallah_kanash` confirmed writing correct values

#### Known user IDs (hardcoded in `server.js`)

```javascript
'd061b1ced0b14049a3a141fa18c96b13': 'smt_admin'
'72d2cc3f3fd94ee7b540d031cba686c6': 'Samira(GM)'
'9fc8ff5cea6c479c9b320215ac98abd5': 'HR'
'3492b2cb01a345e88a8b009d85e1be16': 'omar'
'6750674ddb664b04a4ba52b4f1692215': 'Abdallah Kanash'
```

#### Known Browser Mod hashes

```
9bc6ba13_2a5d956b  →  smt_admin        — Windows Chrome 148
99f1ee5f_37f19c48  →  Abdallah Kanash  — Windows Chrome 148
20352a1e_a52cb1f5  →  Abdallah Kanash  — iPhone HA App v2026.5 (unavailable)
```

#### GMT+3 timestamps

All device action log timestamps displayed in GMT+3 (Amman, Jordan).
Clock in topbar shows current GMT+3 time.

#### Persistent disk cache

`resolution_cache.json` written to `backend/` directory. Keyed by
`context_id`. Once a logbook entry is resolved, it is never re-resolved
— data is stable across Node restarts.