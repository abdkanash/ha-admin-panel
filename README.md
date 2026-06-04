# HA Admin Panel — SOC Interface + REST API

Full-stack live Home Assistant admin panel with security audit, log analysis,
device management, user control, and automation health monitoring.

## Architecture

```
Browser (index.html)
    ↓ fetch
Backend API (server.js :3001)
    ↓ Authorization: Bearer <HA_TOKEN>
Home Assistant REST API (:8123)
```

## Quick Start

### 1. Backend API

```bash
cd backend
npm install
cp .env.example .env
# Edit .env: set HA_URL and HA_TOKEN
npm start
# → http://localhost:3001
```

### Get a HA Long-Lived Token
1. Open Home Assistant → Profile (bottom left)
2. Scroll to "Long-Lived Access Tokens" → Create Token
3. Copy and paste into .env as HA_TOKEN

### 2. Frontend

Option A — open directly:
```bash
open frontend/index.html
```

Option B — serve via any static server:
```bash
npx serve frontend/
# or
python3 -m http.server 8080 --directory frontend/
```

### 3. Connect
1. Open the panel in browser
2. Set API URL: `http://localhost:3001`
3. Paste your HA token (or leave blank if set in .env)
4. Click Connect → Refresh

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | API health check |
| GET | /api/connect | Verify HA connection |
| GET | /api/system/info | HA config + version |
| GET | /api/devices/states | All entity states |
| GET | /api/devices/summary | Device health summary |
| POST | /api/devices/service | Call any HA service |
| GET | /api/automations | All automations with health |
| POST | /api/automations/:id/toggle | Enable/disable automation |
| POST | /api/automations/:id/trigger | Manually trigger automation |
| GET | /api/users | All HA users |
| GET | /api/users/tokens | All refresh tokens |
| DELETE | /api/users/tokens/:id | Revoke a token |
| PATCH | /api/users/:id | Enable/disable user |
| GET | /api/logs | System error log (parsed) |
| GET | /api/logs/history/:entityId | 24h entity history |
| POST | /api/security/notify | Push HA notification |
| GET | /api/audit | Full security audit report |

## Security Notes

- Never expose the backend API to the internet — run on localhost only
- The HA_TOKEN in .env has the same privilege level as the user who created it
  Use an admin token for full functionality
- For production: add authentication to the backend (e.g. basic auth or JWT)
- For remote access: use Cloudflare Tunnel or WireGuard VPN, not port forwarding

## Hardening Checklist (HA side)

```yaml
# configuration.yaml
http:
  ip_ban_enabled: true
  login_attempts_threshold: 5
  use_x_forwarded_for: true
  trusted_proxies:
    - 127.0.0.1
    - ::1
  ssl_certificate: /ssl/fullchain.pem
  ssl_key: /ssl/privkey.pem
```
