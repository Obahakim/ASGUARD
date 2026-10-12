# Asguard Backend Bridge - Complete Documentation

## Overview

The Asguard backend bridge (`server/`) is a Node.js + Express + WebSocket server that connects the Next.js frontend dashboard to the local Astrid daemon (`astridd`). It provides real-time event streaming, policy management, and human-in-the-loop (HITL) security approvals.

**Server runs on**: `localhost:8080`
- REST API: `http://localhost:8080/api/*`
- WebSocket: `ws://localhost:8080/ws`

## Architecture

```
┌─────────────────────┐
│  Next.js Dashboard  │
│  (React Frontend)   │
└──────────┬──────────┘
           │ REST + WebSocket
           ▼
┌─────────────────────────────────────────┐
│     Asguard Backend Bridge (Port 8080)  │
│  ┌───────────────────────────────────┐  │
│  │  Express HTTP Server              │  │
│  │  - REST API (/api/*)              │  │
│  │  - CORS + JSON middleware         │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │  WebSocket Server (ws://)         │  │
│  │  - Real-time event streaming      │  │
│  │  - Client subscription handling   │  │
│  │  - Event broadcasting             │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │  PolicyStore                      │  │
│  │  - ~/.astrid/asguard_policy.json  │  │
│  │  - File I/O + validation          │  │
│  │  - Watchers & callbacks           │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │  Logger                           │  │
│  │  - Terminal formatting (ANSI)     │  │
│  │  - Event broadcasting via WS      │  │
│  │  - Log history + export           │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │  HITL Handler                     │  │
│  │  - Terminal prompts (readline)    │  │
│  │  - Approval decision handling     │  │
│  │  - Request timeout + retry logic  │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
           │ Daemon Integration
           ▼
┌─────────────────────┐
│   Astrid Daemon     │
│  (astridd socket)   │
└─────────────────────┘
```

## File Structure

```
server/
├── index.ts              # Main server entry point + Express routes
├── types.ts              # TypeScript interfaces for all types
├── bridge.ts             # WebSocket bridge implementation
├── policyStore.ts        # Policy file read/write + persistence
├── logger.ts             # Terminal logger + event broadcaster
├── hitlHandler.ts        # HITL approval handler (readline prompts)
└── utils.ts              # [Optional] Utility functions
```

## Core Modules

### 1. **PolicyStore** (`policyStore.ts`)

Manages persistent policy configuration in `~/.astrid/asguard_policy.json`.

**Key Methods:**
- `getPolicy()` - Get current policy
- `updateField(field, value)` - Update single field with validation
- `updatePolicy(updates)` - Bulk update
- `reset()` - Reset to defaults
- `subscribe(callback)` - Watch for changes
- `save()` / `load()` - File I/O

**Policy Structure:**
```typescript
{
  max_auto_trade_usd: number,
  strict_anomaly_detection: boolean,
  device_ip_lock: boolean,
  remote_trigger_protection: boolean,
  active_llm_engine: 'ollama' | 'claude' | 'groq',
  updated_at: string (ISO),
  version: string
}
```

**Example Usage:**
```typescript
import { policyStore } from './server/policyStore';

// Get policy
const policy = policyStore.getPolicy();

// Update field with validation
const updated = policyStore.updateField('max_auto_trade_usd', 50000);

// Subscribe to changes
const unsubscribe = policyStore.subscribe((policy) => {
  console.log('Policy changed:', policy);
});
```

### 2. **Logger** (`logger.ts`)

Formats logs to terminal (ANSI colors) and broadcasts events to WebSocket clients.

**Log Levels:**
- `info` (cyan) - Information
- `warn` (yellow) - Warnings
- `error` (red) - Errors
- `success` (green) - Success messages
- `debug` (magenta) - Debug info

**Key Methods:**
- `info(message, data?)` - Log info
- `warn(message, data?)` - Log warning
- `error(message, data?)` - Log error
- `success(message, data?)` - Log success
- `broadcastEvent(event)` - Log + broadcast to WS
- `getHistory(limit)` - Get recent logs
- `exportLogs()` - Export as JSON

**Example Output:**
```
[2024-01-15T10:23:45.123Z] [INFO   ] Agent connected
[2024-01-15T10:23:46.456Z] [SUCCESS] Policy updated: max_auto_trade_usd
[2024-01-15T10:23:47.789Z] [WARN   ] Anomaly detected: unusual_trade_pattern
[2024-01-15T10:23:48.012Z] [ERROR  ] Connection lost
```

### 3. **WebSocket Bridge** (`bridge.ts`)

Real-time bidirectional communication with dashboard clients.

**Features:**
- Client connection management
- Event subscription filtering
- Event queuing (up to 5000)
- HITL response handling
- Automatic reconnection support (client-side)

**Event Types:**
All events are broadcast to subscribed clients:
- `agent_activity` - Agent actions
- `capability_check` - Permission results
- `anomaly_detected` - Security anomalies
- `security_violation` - Security breaches
- `hitl_request` - Approval requests
- `audit_log` - Audit trail
- `policy_update` - Policy changes
- `connection_status` - Bridge status

**WebSocket Message Format:**
```typescript
// Subscribe to events
{
  "type": "subscribe",
  "payload": {
    "event_types": ["agent_activity", "security_violation"]
  }
}

// Event received
{
  "type": "event",
  "payload": {
    "type": "agent_activity",
    "timestamp": "2024-01-15T10:23:45.123Z",
    "agent_id": "trader-bot-01",
    "agent_name": "Trader Bot",
    "action": "Execute Trade",
    "risk_level": "low",
    "details": {...}
  }
}

// Send HITL response
{
  "type": "hitl_response",
  "payload": {
    "request_id": "req_1234567890",
    "action": "allow_once",
    "reason": "User approved"
  }
}
```

### 4. **HITL Handler** (`hitlHandler.ts`)

Terminal-based human-in-the-loop security approval system.

**Features:**
- Readline terminal prompts
- Request timeout (5 minutes default)
- Pending request tracking
- Graceful terminal shutdown

**Approval Actions:**
1. `allow_once` - One-time approval
2. `allow_session` - Approve for current session
3. `deny_terminate` - Deny and stop agent

**Example Terminal Prompt:**
```
======================================================================
[SECURITY ALERT] Human-in-the-Loop Approval Required
======================================================================

Request ID: req_1234567890
Agent ID: trader-bot-01
Incident Type: unusual_trade_pattern
Expires At: 2024-01-15T10:28:45.123Z

Context:
  trade_value: 500000
  pattern_score: 0.92
  unusual_criteria: "High volume + Off-market hours"

Available Actions:
  1) ✓ Allow Once (one-time approval)
  2) ✓ Allow Session (approve for this session)
  3) ✗ Deny & Terminate (block and stop agent)

Select action [1/2/3] or (q)uit: 
```

## REST API Endpoints

### Health Check
```bash
GET /api/health
# Response:
{
  "status": "ok",
  "daemon_connected": true,
  "timestamp": "2024-01-15T10:23:45.123Z",
  "version": "1.0.0"
}
```

### Get Policy
```bash
GET /api/policy
# Response:
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

### Update Policy Field
```bash
POST /api/policy
Content-Type: application/json

{
  "field": "max_auto_trade_usd",
  "value": 50000
}

# Response:
{
  "success": true,
  "policy": {...}
}
```

### Reset Policy to Defaults
```bash
POST /api/policy/reset
# Response:
{
  "success": true,
  "policy": {...}
}
```

### Simulate Agent Activity (Testing)
```bash
POST /api/events/agent-activity
Content-Type: application/json

{
  "agent_id": "trader-bot-01",
  "agent_name": "Trader Bot",
  "action": "Execute Trade",
  "risk_level": "low",
  "details": {
    "trade_value": 100000,
    "pair": "BTC/USD"
  }
}
```

### Simulate Security Violation (Testing)
```bash
POST /api/events/security-violation
Content-Type: application/json

{
  "agent_id": "trader-bot-01",
  "violation_type": "unusual_trade_pattern",
  "severity": "high",
  "requires_hitl": true,
  "context": {
    "trade_value": 500000,
    "pattern_score": 0.92
  }
}
# This will trigger HITL prompt in terminal
```

### Get Server Stats
```bash
GET /api/stats
# Response:
{
  "connected_clients": 3,
  "recent_events": [...],
  "uptime_ms": 12345678
}
```

## Installation & Setup

### 1. Install Dependencies
```bash
# Install all dependencies (includes backend)
pnpm install
```

### 2. Run Development Server
```bash
# Run both frontend (Next.js) and backend (Express) concurrently
pnpm dev

# Or run them separately:
pnpm dev:frontend      # Next.js on port 3000
pnpm dev:backend       # Backend on port 8080
```

### 3. Build for Production
```bash
# Build Next.js frontend
pnpm build

# Build server TypeScript (if needed)
npx tsc -p tsconfig.server.json
```

### 4. Production Deployment
```bash
# Start frontend
pnpm start

# Start backend in another terminal
pnpm backend:start
```

## Frontend Integration

### Using the WebSocket Hook

```typescript
'use client';

import { useBridgeConnection } from '@/hooks/useBridgeConnection';
import { EventType } from '@/server/types';

export function DashboardComponent() {
  const { isConnected, lastEvent, events, subscribe } =
    useBridgeConnection(
      (event) => {
        console.log('New event:', event);
      },
      {
        url: 'ws://localhost:8080/ws',
        eventTypes: [
          'agent_activity',
          'security_violation',
          'anomaly_detected',
        ],
        autoConnect: true,
      }
    );

  return (
    <div>
      <div>
        Status: {isConnected ? '🟢 Connected' : '🔴 Disconnected'}
      </div>
      <div>Last Event: {lastEvent?.type}</div>
      <div>Total Events: {events.length}</div>
    </div>
  );
}
```

### Updating Policy via REST

```typescript
async function updatePolicy(field: string, value: unknown) {
  const res = await fetch('http://localhost:8080/api/policy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ field, value }),
  });

  const data = await res.json();
  console.log('Policy updated:', data.policy);
}

// Usage
await updatePolicy('max_auto_trade_usd', 75000);
```

## Environment Variables

```bash
# Backend configuration (optional)
ASGUARD_PORT=8080              # Server port (default: 8080)
ASGUARD_HOST=localhost         # Server host (default: localhost)
HOME=/home/user                # Home directory for policy file
```

## File Locations

- **Policy File**: `~/.astrid/asguard_policy.json`
- **Logs**: Terminal stdout (ANSI colored)
- **Config**: Environment variables

## Debugging

### Enable Verbose Logging
```typescript
// In server/index.ts, logger calls already include verbose output
// Terminal shows all events with colors and details
```

### View Recent Events
```bash
curl http://localhost:8080/api/stats | jq '.recent_events'
```

### Test WebSocket Connection
```bash
# Install wscat: npm install -g wscat
wscat -c ws://localhost:8080/ws

# Send subscription message
> {"type":"subscribe","payload":{"event_types":["agent_activity"]}}

# Send HITL response
> {"type":"hitl_response","payload":{"request_id":"req_123","action":"allow_once"}}
```

## Integration with Astrid Daemon

Currently, the backend serves as a standalone bridge. Future integration with `astridd`:

1. **Event Ingestion**: Listen to daemon socket for events
2. **Policy Enforcement**: Apply policies to agent actions
3. **Command Execution**: Execute approval decisions back to daemon
4. **Health Checks**: Monitor daemon connection status

## Error Handling

All errors are logged with context:
- Terminal: Colored error messages
- WebSocket: Error events sent to clients
- REST API: HTTP error responses with descriptions
- File I/O: Graceful fallback to defaults

## Performance Notes

- Event queue: 5000 max (FIFO)
- Log history: 1000 max (in-memory)
- Policy updates: Atomic file writes (fs.writeFileSync)
- WebSocket: Per-message deflate disabled for performance
- HITL: 5-minute timeout per request

## Security Considerations

- Policy file permissions: User-only (implicit via ~/.astrid)
- REST and MCP endpoints require configured API credentials with role checks
- WebSocket tickets are short-lived and single-use; ticketed connections are origin-checked
- Human decisions are accepted from authenticated admin/operator roles
- Credentials: Never logged or broadcast
- CORS: restricted to `ASGUARD_ALLOWED_ORIGINS`; use HTTPS/WSS through a trusted reverse proxy for remote access

## Solana Devnet and MCP

The current chain adapter targets Solana devnet and verifies the devnet genesis hash before simulation or submission. MCP clients use `POST /mcp` with a bearer API credential. The tool set includes `asguard_get_status`, `asguard_get_policy`, `asguard_get_transaction_status`, `asguard_report_activity`, `asguard_report_security_violation`, and `asguard_guarded_solana_send`.

The guarded send path stores an idempotent intent, evaluates agent activity, simulates the signed transaction, requests human approval, and submits only after approval. The local demo client is `pnpm demo:trader`; it creates synthetic activity and compromise-alert events only, without a wallet or transaction. See `SOLANA_MCP_SETUP.md` for Claude Code configuration and test steps.

The demo and MCP control plane do not terminate an independent bot process. A bot can bypass ASGUARD if it can broadcast directly, so production deployment must constrain RPC egress and signing authority. Transaction amount is currently caller-declared and unverified, which is why all sends wait for a human.

## Future Enhancements

1. **Daemon Integration**: Connect to astridd socket
2. **Durable audit storage**: Persist complete audit events to PostgreSQL/SQLite
3. **Metrics**: Prometheus-compatible endpoint
4. **Clustering**: Multiple server instances with load balancing
5. **Rate Limiting**: DDoS protection for REST and MCP APIs
6. **Event Replay**: Resend historical events to new clients

## Support & Debugging

For issues:
1. Check terminal output for error messages
2. Verify policy file exists: `cat ~/.astrid/asguard_policy.json`
3. Test API: `curl http://localhost:8080/api/health`
4. Test WebSocket: Use `wscat` or browser DevTools
5. Check logs: Review terminal output with timestamps
