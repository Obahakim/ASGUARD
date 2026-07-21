# Phase 4: Asguard Daemon Integration & Local Deployment

## Overview

Phase 4 completes the Asguard system by:
- Adding **Terminal UI with colored risk tags** (Green/Yellow/Red)
- Creating **Rust WASM capsule** for daemon integration
- Providing **installation & startup scripts** for local deployment
- Enabling **CLI commands** for operational management

## Architecture

```
┌──────────────────────────────────┐
│     Astrid Daemon (astridd)      │
├──────────────────────────────────┤
│  Tool Call Interceptor           │
│           ↓                      │
│  ┌──────────────────────────┐   │
│  │ Asguard WASM Capsule     │   │
│  │ • Load policy            │   │
│  │ • Evaluate (4 rules)     │   │
│  │ • Trigger HITL @ ≥70     │   │
│  │ • Sign audit entries     │   │
│  └──────────────────────────┘   │
│           ↓                      │
│  Decision: allow/deny/halt       │
└──────────────────────────────────┘
      ↓                    ↓
 Daemon Action    WebSocket Event
      ↓                    ↓
┌──────────────────────────────────┐
│  Asguard Backend (Node.js)       │
│  localhost:8080                  │
├──────────────────────────────────┤
│ • Terminal UI (colored output)   │
│ • HITL prompts (readline)        │
│ • Event streaming                │
│ • Policy management              │
│ • Audit chain verification       │
└──────────────────────────────────┘
      ↓
┌──────────────────────────────────┐
│  Web Dashboard (Next.js)         │
│  localhost:3000                  │
│  • Real-time events              │
│  • Anomaly scores & rules        │
│  • HITL approval UI              │
│  • Policy editor                 │
└──────────────────────────────────┘
```

## Components Built

### 1. Terminal UI (`server/terminalView.ts`)

Provides **colored, interactive terminal display** with:
- **Risk Tags**: Green (Low), Yellow (Medium), Red (High/Critical)
- **Anomaly Score Color Gradient**: Green <40, Yellow 40-69, Red ≥70
- **Rule Violation Formatting**: Hierarchical display with details
- **HITL Prompts**: Interactive readline with 3 options (Allow Once/Session, Deny)
- **Event History**: In-memory storage (max 1,000 entries)

**Key Functions:**
- `formatRiskTag(level)` → Colored risk indicator
- `formatAnomalyScore(score)` → Gradient color based on score
- `formatEvaluationResult(eval)` → Full anomaly display
- `TerminalHITL.promptApproval()` → Interactive HITL prompt
- `EventFormatter` → Event history with export

**Color Scheme:**
```
Risk Level  Color   Used For
──────────────────────────────────
Low         Green   ● LOW
Medium      Yellow  ● MEDIUM
High        Red     ● HIGH
Critical    Bright  ● CRITICAL
            Red
```

### 2. Event Interceptor (`server/eventInterceptor.ts`)

Routes **events through terminal display** with:
- Event type detection (agent_activity, anomaly_detected, hitl_request, audit_log)
- Smart formatting per event type
- HITL request handling with interactive prompts
- History export capability

**Event Flow:**
```
Event → EventInterceptor.interceptEvent()
  ├─ agent_activity → formatAndLog(event)
  ├─ anomaly_detected → formatEvaluation() + conditional HITL
  ├─ hitl_request → terminalHITL.promptApproval() [interactive]
  └─ audit_log → formatAndLog(event)
```

### 3. Rust WASM Capsule

**Structure:**
```
capsule/
├── Cargo.toml
└── src/
    ├── lib.rs          (main API, WASM exports)
    ├── policy.rs       (policy loading/management)
    ├── evaluator.rs    (4-rule anomaly detection)
    └── audit.rs        (chain-linked audit logs)
```

**Modules:**

#### `lib.rs` - Main Capsule
- `AsguardCapsule` struct wraps all components
- `initialize(config)` loads policy and audit chain
- `evaluate_tool_call()` runs anomaly detection
- `diagnostics()` returns system stats
- WASM exports: `asguard_init_capsule()`, `asguard_evaluate_tool_call()`

#### `policy.rs` - Policy Manager
- `AsguardPolicy` struct with 5 fields:
  - `max_auto_trade_usd`: Budget limit
  - `strict_anomaly_detection`: Master toggle
  - `device_ip_lock`: IP/device tracking
  - `remote_trigger_protection`: Remote call blocking
  - `active_llm_engine`: LLM selection
- `PolicyStore` loads from `~/.astrid/asguard_policy.json`
- Automatic default creation if missing

#### `evaluator.rs` - Anomaly Detection
- `Evaluator` with agent profile caching
- Implements 4 rules in `evaluate()`:
  1. Budget Overrun (Rule 2): +50 if amount > limit
  2. IP/Device Breach (Rule 1): +40 (IP), +35 (device)
  3. Frequency Spike (Rule 3): +30 if >300% baseline
  4. Unverified Contract (Rule 4): +45 if not whitelisted
- Score: 0-100 capped
- Whitelist: USDC, USDT, WBTC

#### `audit.rs` - Audit Chain
- `AuditEntry` with cryptographic signing
- `AuditChain` manages linked entries
- SHA256 hashing + HMAC-SHA256 signatures
- `verify_integrity()` checks chain links
- Persistence to `~/.astrid/audit_chain.json`

### 4. Installation Script (`install.sh`)

**Checks:**
- Rust/Cargo installed
- Node.js installed
- pnpm (optional, fallback to npm)
- astrid-cli (optional)

**Setup Steps:**
1. Creates `~/.astrid/` directory
2. Initializes `asguard_policy.json` with defaults
3. Installs Node dependencies
4. Compiles Rust capsule (if available)
5. Creates CLI symlink in `/usr/local/bin/asguard`
6. Provides next steps guide

### 5. CLI Wrapper (`scripts/asguard.sh`)

Provides convenient commands:

**Commands:**
- `asguard start` → Start backend + frontend
- `asguard status` → System health check
- `asguard logs` → Stream live diagnostics
- `asguard policy [get|set|reset]` → Manage security policy
- `asguard audit [export|verify]` → Export/verify audit trail
- `asguard uninstall` → Remove Asguard

**Status Output Example:**
```
Asguard System Status:
────────────────────────────────────────
✓ Backend is running (http://localhost:8080)
  Status: ok
✓ Frontend is running (http://localhost:3000)
✓ Policy file exists: ~/.astrid/asguard_policy.json
✓ Audit chain: 42 entries
```

## Installation & Setup

### Quick Start (5 minutes)

```bash
# 1. Navigate to project
cd /path/to/asguard

# 2. Run installation script
./install.sh

# 3. Start services
npm run daemon:start
# or: ./scripts/asguard.sh start

# 4. Open dashboard
open http://localhost:3000
# or: curl http://localhost:8080/api/health
```

### Manual Installation

```bash
# Create policy directory
mkdir -p ~/.astrid

# Initialize policy
cat > ~/.astrid/asguard_policy.json << 'EOF'
{
  "max_auto_trade_usd": 50000,
  "strict_anomaly_detection": true,
  "device_ip_lock": true,
  "remote_trigger_protection": true,
  "active_llm_engine": "ollama"
}
EOF

# Install Node dependencies
npm install  # or: pnpm install

# Start backend
npm run dev:backend

# Start frontend (in another terminal)
npm run dev:frontend

# Test API
curl http://localhost:8080/api/health
```

## CLI Usage Examples

### Check System Status
```bash
asguard status

# Output:
# Asguard System Status:
# ────────────────────────────────────────
# ✓ Backend is running (http://localhost:8080)
# ✓ Frontend is running (http://localhost:3000)
```

### View & Modify Policy
```bash
# Get current policy
asguard policy get

# Set budget limit to $100,000
asguard policy set max_auto_trade_usd 100000

# Disable anomaly detection for testing
asguard policy set strict_anomaly_detection false

# Re-enable
asguard policy set strict_anomaly_detection true

# Reset to defaults
asguard policy reset
```

### Export Audit Trail
```bash
# Export for compliance
asguard audit export compliance_report_2024.json

# Verify chain integrity
asguard audit verify
# Output: ✓ Audit chain is valid and tamper-proof
```

### Stream Live Logs
```bash
# Watch real-time diagnostics
asguard logs

# Refreshes every 5 seconds with:
# - Profile count
# - Audit chain status
# - Contract validation cache
```

## Testing the Integration

### 1. Simulate Agent Activity
```bash
curl -X POST http://localhost:8080/api/events/agent-activity \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "trader-bot-01",
    "agent_name": "Trader Bot",
    "action": "execute_trade",
    "amount_usd": 60000,
    "ip_address": "203.0.113.1",
    "contract_address": "0xUnknownContract"
  }'

# Expected: HITL triggered (score ≥ 70)
# Watch terminal for colored prompts
```

### 2. Test HITL Prompt
- Select option "1" (Allow Once)
- Check dashboard for decision recorded
- Verify audit chain entry created

### 3. Verify Audit Chain
```bash
asguard audit verify

# Output: ✓ Audit chain is valid and tamper-proof
```

## File Structure

```
asguard/
├── app/                          # Next.js frontend
│   ├── components/               # React components
│   ├── page.tsx                  # Dashboard
│   └── layout.tsx
├── server/                       # Node.js backend
│   ├── index.ts                  # Main server
│   ├── bridge.ts                 # WebSocket
│   ├── policyStore.ts            # Policy management
│   ├── logger.ts                 # Terminal logging
│   ├── hitlHandler.ts            # HITL approval
│   ├── anomalyEngine.ts          # Orchestrator
│   ├── profileManager.ts         # Behavioral baselines
│   ├── evaluator.ts              # 4 detection rules
│   ├── contractValidator.ts      # Contract verification
│   ├── auditChain.ts             # Cryptographic logs
│   ├── terminalView.ts           # Terminal UI (NEW)
│   └── eventInterceptor.ts       # Event routing (NEW)
├── capsule/                      # Rust WASM module (NEW)
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs                # Main capsule
│       ├── policy.rs             # Policy loading
│       ├── evaluator.rs          # 4-rule detection
│       └── audit.rs              # Audit chain
├── scripts/
│   ├── asguard.sh                # CLI wrapper (NEW)
├── hooks/
│   └── useBridgeConnection.ts    # React hook
├── install.sh                    # Setup script (NEW)
├── package.json                  # Updated with Phase 4 scripts
├── PHASE4_DAEMON_INTEGRATION.md  # This file
└── [other files...]
```

## Environment Setup

### Required Environment Variables
```bash
# For Astrid daemon connection
export ASTRID_SOCKET=/tmp/astrid.sock  # (optional)

# Terminal logging
export ASGUARD_LOG_LEVEL=info          # (optional)

# Policy location
export ASGUARD_POLICY_PATH=~/.astrid/asguard_policy.json
```

### Optional Configuration
```bash
# Enable debug logging
export ASGUARD_DEBUG=true

# Custom policy path
export ASGUARD_POLICY_PATH=/etc/asguard/policy.json

# Audit chain location
export ASGUARD_AUDIT_PATH=/var/log/asguard/audit_chain.json
```

## Troubleshooting

### Backend Not Starting
```bash
# Check if port 8080 is in use
lsof -i :8080

# Kill process if needed
kill -9 $(lsof -t -i :8080)

# Restart backend
npm run dev:backend
```

### Policy File Not Found
```bash
# Ensure directory exists
mkdir -p ~/.astrid

# Reinitialize policy
curl -X POST http://localhost:8080/api/policy/reset
```

### Audit Chain Corrupted
```bash
# Verify integrity
asguard audit verify

# If failed, backup and reinitialize
mv ~/.astrid/audit_chain.json ~/.astrid/audit_chain.json.bak
# Restart backend to create new chain
```

### HITL Prompt Not Appearing
```bash
# Check terminal is attached to TTY
tty

# Ensure event interceptor is initialized
npm run dev:backend  # Use this instead of direct node

# Check anomaly score ≥ 70
curl http://localhost:8080/api/anomaly/diagnostics | jq '.diagnostics'
```

## Next Steps (Phase 5+)

1. **Production Deployment**:
   - Containerize with Docker
   - Deploy to K8s cluster
   - Setup monitoring/alerting

2. **Advanced Features**:
   - Machine learning-based anomaly scoring
   - Multi-agent coordination
   - Advanced HITL workflows

3. **Compliance & Audit**:
   - SOC2 audit trail export
   - Digital signature verification
   - Third-party audit tools integration

4. **Performance**:
   - Profile caching optimization
   - Batch evaluation mode
   - Event queue tuning

## Support & Documentation

- **Terminal UI**: See `server/terminalView.ts` inline comments
- **CLI Commands**: `asguard help`
- **API Reference**: `curl http://localhost:8080/api/health`
- **Audit Verification**: `asguard audit verify`

## Quick Reference

| Command | Purpose |
|---------|---------|
| `asguard start` | Start services |
| `asguard status` | Check health |
| `asguard logs` | Stream diagnostics |
| `asguard policy get` | View policy |
| `asguard policy set X Y` | Update policy |
| `asguard audit export` | Export for compliance |
| `asguard audit verify` | Verify integrity |

