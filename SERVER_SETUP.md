# Asguard Backend - Quick Start Guide

## Overview

The Asguard backend bridge provides:
- ✅ REST API on `http://localhost:8080/api/*`
- ✅ Role-protected REST API with named service identities
- ⚠️ WebSocket real-time events on `ws://localhost:8080/ws` (currently unauthenticated; keep loopback-only)
- ✅ Local policy file management at `~/.astrid/asguard_policy.json`
- ✅ Terminal-based HITL approval prompts
- ✅ Full TypeScript type safety

## Installation

1. **Install dependencies** (already done if you ran `npm install`):
```bash
npm install
```

2. **Verify TypeScript compilation**:
```bash
npx tsc --noEmit -p tsconfig.server.json
```

## Configure API identities

The backend requires `ASGUARD_API_CREDENTIALS` and `ASGUARD_AUDIT_KEY` before startup. Copy `.env.example` to `.env` and replace the short placeholders with distinct random secrets of at least 32 bytes. `.env` is ignored by Git, and the backend development scripts load it automatically. For deployment, inject the values through a secret manager instead. Do not commit secrets.

`ASGUARD_API_CREDENTIALS` is a JSON array of `{ "id", "token", "roles" }` records. Supported roles are `runtime`, `operator`, `auditor`, and `admin`:
- `runtime`: submit agent activity and security-violation events
- `operator` and `auditor`: read health, policy, diagnostics, stats, and audit data
- `admin`: read data, submit events, update policy, and reset profiles

Example structure only; replace both token placeholders with separate generated secrets:
```json
[
  { "id": "runtime-local", "token": "<runtime-secret>", "roles": ["runtime"] },
  { "id": "admin-local", "token": "<admin-secret>", "roles": ["admin", "operator", "auditor"] }
]
```

Alternatively, for local development in Windows PowerShell, generate fresh values in the current terminal before starting the backend:
```powershell
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$runtimeBytes = New-Object byte[] 32
$adminBytes = New-Object byte[] 32
$auditBytes = New-Object byte[] 32
$rng.GetBytes($runtimeBytes)
$rng.GetBytes($adminBytes)
$rng.GetBytes($auditBytes)
$runtimeToken = [Convert]::ToBase64String($runtimeBytes)
$adminToken = [Convert]::ToBase64String($adminBytes)
$env:ASGUARD_AUDIT_KEY = [Convert]::ToBase64String($auditBytes)
$env:ASGUARD_API_CREDENTIALS = @(
  @{ id = 'runtime-local'; token = $runtimeToken; roles = @('runtime') },
  @{ id = 'admin-local'; token = $adminToken; roles = @('admin', 'operator', 'auditor') }
) | ConvertTo-Json -Compress
```

## Running the Backend

### Option 1: Run Both Frontend + Backend Together (Recommended)
```bash
npm run dev
```

This will start:
- Frontend: `http://localhost:3000` (Next.js)
- Backend: `http://localhost:8080` (Express + WebSocket)

Both will watch for changes and automatically reload.

### Option 2: Run Backend Only
```bash
npm run dev:backend
```

Runs backend server with TypeScript watch mode. Useful for testing the API independently.

### Option 3: Run Frontend Only
```bash
npm run dev:frontend
```

Runs only the Next.js frontend on port 3000.

## Testing the Backend

### 1. Check Health Status
```bash
curl -H "Authorization: Bearer <admin-token>" http://localhost:8080/api/health
```

**Response:**
```json
{
  "status": "ok",
  "daemon_connected": true,
  "timestamp": "2024-01-15T10:23:45.123Z",
  "version": "1.0.0"
}
```

### 2. Get Current Policy
```bash
curl -H "Authorization: Bearer <admin-token>" http://localhost:8080/api/policy
```

**Response:**
```json
{
  "success": true,
  "policy": {
    "max_auto_trade_usd": 10000,
    "strict_anomaly_detection": true,
    "device_ip_lock": true,
    "remote_trigger_protection": true,
    "active_llm_engine": "ollama",
    "updated_at": "2024-01-15T10:23:45.123Z",
    "version": "1.0.0"
  }
}
```

### 3. Update Policy Field
```bash
curl -X POST http://localhost:8080/api/policy \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <admin-token>" \
  -d '{"field": "max_auto_trade_usd", "value": 50000}'
```

### 4. Simulate Agent Activity (Testing)
```bash
curl -X POST http://localhost:8080/api/events/agent-activity \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <runtime-token>" \
  -d '{
    "agent_id": "trader-bot-01",
    "agent_name": "Trader Bot",
    "action": "Execute Trade",
    "risk_level": "low",
    "details": {"trade_value": 100000, "pair": "BTC/USD"}
  }'
```

Check the terminal running `pnpm dev:backend` - you should see colored event logs!

### 5. Simulate Security Violation (with HITL)
```bash
curl -X POST http://localhost:8080/api/events/security-violation \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <runtime-token>" \
  -d '{
    "agent_id": "trader-bot-01",
    "violation_type": "unusual_trade_pattern",
    "severity": "high",
    "requires_hitl": true,
    "context": {"trade_value": 500000, "pattern_score": 0.92}
  }'
```

**This will trigger an interactive terminal prompt!** You'll see:
```
======================================================================
[SECURITY ALERT] Human-in-the-Loop Approval Required
======================================================================

Request ID: req_1234567890
Agent ID: trader-bot-01
Incident Type: unusual_trade_pattern
...

Available Actions:
  1) ✓ Allow Once (one-time approval)
  2) ✓ Allow Session (approve for this session)
  3) ✗ Deny & Terminate (block and stop agent)

Select action [1/2/3] or (q)uit:
```

Type `1`, `2`, `3`, or `q` to respond!

### 6. Test WebSocket Connection
Install `wscat` for testing:
```bash
npm install -g wscat
```

Connect to WebSocket:
```bash
wscat -c ws://localhost:8080/ws
```

The WebSocket endpoint is not authenticated yet. Use it only for local development and do not expose the backend port to an untrusted network.

Subscribe to events:
```json
{"type":"subscribe","payload":{"event_types":["agent_activity","security_violation"]}}
```

You'll receive real-time events as they happen!

### 7. Get Server Stats
```bash
curl -H "Authorization: Bearer <admin-token>" http://localhost:8080/api/stats | jq
```

**Response:**
```json
{
  "connected_clients": 2,
  "recent_events": [...],
  "uptime_ms": 12345678
}
```

## Frontend Integration

The frontend components automatically connect to the backend if running on `localhost:3000` and `localhost:8080`.

### Dashboard Components

1. **Navbar** - Shows connection status (green dot = connected)
2. **ActivityFeed** - Displays real-time agent activities from WebSocket
3. **SecurityRules** - Policy sliders sync via REST API
4. **AnomalyDetection** - Incident list updates via WebSocket events
5. **ApprovalModal** - HITL requests shown as modal + terminal prompts

### How It Works

1. Dashboard loads → connects to WebSocket at `ws://localhost:8080/ws`
2. User adjusts policy slider → POST to `/api/policy`
3. Backend writes to `~/.astrid/asguard_policy.json` 
4. Backend broadcasts `policy_update` event to all connected clients
5. Dashboard updates in real-time via WebSocket

## Policy File Location

Policy file is stored at:
```
~/.astrid/asguard_policy.json
```

**Example policy file:**
```json
{
  "max_auto_trade_usd": 10000,
  "strict_anomaly_detection": true,
  "device_ip_lock": true,
  "remote_trigger_protection": true,
  "active_llm_engine": "ollama",
  "updated_at": "2024-01-15T10:23:45.123Z",
  "version": "1.0.0"
}
```

You can edit this file directly, and the backend will load it on startup.

## Terminal Output

When you run `pnpm dev`, the backend logs are color-coded:
- 🔵 **[INFO]** (cyan) - Information messages
- 🟢 **[SUCCESS]** (green) - Successful operations
- 🟡 **[WARN]** (yellow) - Warnings and anomalies
- 🔴 **[ERROR]** (red) - Errors and violations
- 🟣 **[DEBUG]** (magenta) - Debug information

Example output:
```
[2024-01-15T10:23:45.123Z] [SUCCESS] Asguard bridge listening on http://localhost:8080
[2024-01-15T10:23:46.456Z] [INFO   ] Client connected: client_1
[2024-01-15T10:23:47.789Z] [SUCCESS] Policy updated: max_auto_trade_usd
[2024-01-15T10:23:48.012Z] [WARN   ] Anomaly detected: unusual_trade_pattern
```

## Troubleshooting

### Port Already in Use
If port 8080 is already in use:
```bash
# Change the port (set before running)
ASGUARD_PORT=8081 pnpm dev:backend
```

### WebSocket Connection Failed
- Verify backend is running with an authorized admin token: `curl -H "Authorization: Bearer <admin-token>" http://localhost:8080/api/health`
- Check browser console for connection errors
- Ensure no firewall blocking localhost:8080

### Policy File Not Found
Policy file is created automatically on first run. If it doesn't exist:
```bash
mkdir -p ~/.astrid
```

### HITL Prompt Not Appearing
- Make sure you're running the backend in a terminal that supports stdin/stdout
- HITL only works when `requires_hitl: true` is set in the violation event
- Terminal must not be redirected (avoid `> /dev/null`)

## Environment Variables

```bash
# Backend port (default: 8080)
ASGUARD_PORT=8080

# Backend host (default: localhost)
ASGUARD_HOST=localhost

# Required: JSON array of named credentials and roles
ASGUARD_API_CREDENTIALS='[{"id":"runtime-local","token":"<runtime-secret>","roles":["runtime"]},{"id":"admin-local","token":"<admin-secret>","roles":["admin","operator","auditor"]}]'

# Required: random audit signing key, at least 32 bytes
ASGUARD_AUDIT_KEY='<audit-secret>'

# Home directory (for policy file location)
HOME=/home/user
```

## Mainnet readiness

`UNICITY_NETWORK=mainnet`, `UNICITY_GATEWAY_URL=https://gateway.mainnet.unicity.network`, and `UNICITY_WALLET_API_URL=https://wallet-api.mainnet.unicity.network` are the documented mainnet settings. `UNICITY_DEVICE_ID` should be a stable, unique identifier for this server. `UNICITY_DATA_DIR` should be a persistent, private directory and must not share testnet wallet files.

`UNICITY_ORACLE_API_KEY` is a secret issued by the Unicity network operator; request a mainnet key from them. Do not use the public testnet key. `UNICITY_WALLET_PASSWORD` is a long, unique password you generate and store in your secret manager. Do not paste either value into chat or commit them.

The SDK's current mainnet registry lists no fungible coins. The project does not yet implement an SDK-backed wallet, transaction simulation, or real send/confirmation flow, so changing these URLs alone does not make mainnet transfers available. Mainnet submission must remain disabled until a supported asset, wallet initialization, preflight, approval, and SDK send path are implemented and tested.

## Next Steps

1. **Start the servers**: `pnpm dev`
2. **Open dashboard**: `http://localhost:3000`
3. **Test API endpoint**: `curl -H "Authorization: Bearer <admin-token>" http://localhost:8080/api/health`
4. **Trigger test event**: Use the curl commands above
5. **Watch terminal**: See color-coded logs as events flow through

## File Structure

```
server/
├── index.ts              # Main server + Express routes
├── types.ts              # TypeScript type definitions
├── bridge.ts             # WebSocket bridge
├── policyStore.ts        # Policy file management
├── logger.ts             # Terminal logger + broadcaster
├── hitlHandler.ts        # HITL interactive prompts

app/
├── components/
│   ├── ActivityFeed.tsx  # Displays real-time agent events
│   ├── SecurityRules.tsx # Policy controls with API integration
│   ├── AnomalyDetection.tsx # Incident list
│   ├── ApprovalModal.tsx # HITL modal
│   └── ...

hooks/
├── useBridgeConnection.ts # React hook for WebSocket connection
```

## Production Deployment

See [BACKEND.md](./BACKEND.md) for comprehensive documentation on production deployment, advanced features, and daemon integration.

## Support

For detailed API documentation, see [BACKEND.md](./BACKEND.md).

Happy testing! 🚀
