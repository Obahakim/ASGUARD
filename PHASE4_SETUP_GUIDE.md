# Phase 4: Quick Setup Guide

## What's New in Phase 4

✅ **Terminal UI** with color-coded risk tags (Green/Yellow/Red)  
✅ **Event Interceptor** routing anomalies to terminal display  
✅ **Rust WASM Capsule** for daemon integration  
✅ **Installation Script** for one-command setup  
✅ **CLI Wrapper** with 6 operational commands  

---

## Installation (5 minutes)

### Option 1: Automated Setup (Recommended)

```bash
cd /path/to/asguard
chmod +x install.sh
./install.sh
```

This will:
- ✓ Check dependencies (Rust, Node, pnpm)
- ✓ Create `~/.astrid/` directory
- ✓ Initialize policy file
- ✓ Install Node dependencies
- ✓ Compile Rust capsule
- ✓ Create CLI symlink

### Option 2: Manual Setup

```bash
# 1. Create policy directory
mkdir -p ~/.astrid

# 2. Create default policy
cat > ~/.astrid/asguard_policy.json << 'EOF'
{
  "max_auto_trade_usd": 50000,
  "strict_anomaly_detection": true,
  "device_ip_lock": true,
  "remote_trigger_protection": true,
  "active_llm_engine": "ollama"
}
EOF

# 3. Install dependencies
npm install  # or: pnpm install

# 4. (Optional) Compile Rust capsule
cd capsule && cargo build --release && cd ..
```

---

## Getting Started

### Start Services

```bash
# Option A: Use npm scripts
npm run daemon:start

# Option B: Use CLI wrapper
./scripts/asguard.sh start

# Option C: Use bash command (after install.sh)
asguard start
```

You'll see:
```
╔════════════════════════════════════════════════════════════════════╗
║      Asguard - Daemon Security Interface                          ║
║      Ready to intercept anomalies and events                      ║
╚════════════════════════════════════════════════════════════════════╝

Starting backend on http://localhost:8080
Starting frontend on http://localhost:3000
Press Ctrl+C to stop
```

### Open Dashboard

```bash
# Web UI
open http://localhost:3000

# or terminal
curl http://localhost:8080/api/health
```

---

## CLI Commands

### Check Status
```bash
asguard status

Output:
Asguard System Status:
────────────────────────────────────────
✓ Backend is running (http://localhost:8080)
  Status: ok
✓ Frontend is running (http://localhost:3000)
✓ Policy file exists: ~/.astrid/asguard_policy.json
✓ Audit chain: 0 entries
```

### View Policy
```bash
asguard policy get

Output:
{
  "max_auto_trade_usd": 50000,
  "strict_anomaly_detection": true,
  "device_ip_lock": true,
  "remote_trigger_protection": true,
  "active_llm_engine": "ollama"
}
```

### Update Policy
```bash
# Set budget limit to $100,000
asguard policy set max_auto_trade_usd 100000

# Disable anomaly detection (testing only)
asguard policy set strict_anomaly_detection false

# Re-enable
asguard policy set strict_anomaly_detection true

# Reset to defaults
asguard policy reset
```

### Export Audit Trail
```bash
# Export for compliance review
asguard audit export compliance_report.json

# Verify chain integrity (tamper detection)
asguard audit verify

Output: ✓ Audit chain is valid and tamper-proof
```

### Stream Diagnostics
```bash
# Watch real-time metrics (updates every 5 seconds)
asguard logs

Ctrl+C to stop
```

---

## Testing the Integration

### Test 1: Trigger Anomaly Detection

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
```

**Expected Result:**
- Anomaly score: ~85/100 (Budget Overrun +50, Unverified Contract +45)
- Terminal shows: **RED** "● CRITICAL" tag
- HITL prompt appears in terminal

### Test 2: Respond to HITL Prompt

```
╔════════════════════════════════════════════════════════════╗
║  HUMAN-IN-THE-LOOP APPROVAL REQUIRED                      ║
╚════════════════════════════════════════════════════════════╝

Agent: trader-bot-01
Violation: budget_overrun

Options:
  1 - Allow Once        (proceed with this action only)
  2 - Allow Session     (allow similar actions for this session)
  3 - Deny & Halt       (block this action and terminate)

Your decision (1-3): 1
✓ Decision: Allow Once
```

### Test 3: Verify Audit Chain

```bash
asguard audit verify

Output: ✓ Audit chain is valid and tamper-proof
```

---

## Terminal Output Examples

### Low Risk Activity
```
[14:32:18] 🔵 ACTIVITY Bot-01: query_data
  Risk: ● LOW
```

### Medium Risk Warning
```
[14:32:25] 🟡 ANOMALY Bot-02
  Score: 🟡 55/100
  Action: WARN
  Confidence: 85%
Rules: Frequency Spike (+30), Device Breach (+25)
```

### High Risk - HITL Triggered
```
[14:32:31] 🔴 ANOMALY Bot-03
  Score: 🔴 85/100
  Action: HALT & HITL
  Confidence: 95%

Rules Triggered (3):
  1. budget_overrun
     Severity: HIGH
     Score: +50
     Details: amount: 75000, max_allowed: 50000
  
  2. unverified_contract
     Severity: HIGH
     Score: +45
     Details: contract: 0xUnsafeAddress

[Interactive prompt appears...]
```

---

## Configuration Files

### Policy File: `~/.astrid/asguard_policy.json`

```json
{
  "max_auto_trade_usd": 50000,          # Budget limit
  "strict_anomaly_detection": true,      # Enable detection
  "device_ip_lock": true,                # Track IP/device
  "remote_trigger_protection": true,     # Block remote calls
  "active_llm_engine": "ollama"          # LLM choice
}
```

### Audit Chain: `~/.astrid/audit_chain.json`

```json
[
  {
    "sequence_number": 1,
    "timestamp": "2024-07-21T14:32:31Z",
    "agent_id": "trader-bot-01",
    "action": "tool_call: execute_trade",
    "anomaly_score": 75,
    "previous_hash": "0000...",
    "entry_hash": "a1b2c3d4...",
    "signature": "a1b2c3d4_0000..."
  }
]
```

---

## Troubleshooting

### Backend Won't Start
```bash
# Check if port 8080 is in use
lsof -i :8080

# Kill if needed
kill -9 $(lsof -t -i :8080)

# Restart
npm run daemon:start
```

### Policy File Not Found
```bash
# Manually initialize
mkdir -p ~/.astrid
asguard policy reset
```

### Terminal Prompts Not Appearing
```bash
# Ensure TTY is attached
tty

# Use proper terminal wrapper
npm run daemon:start  # Not direct node command
```

### Audit Chain Integrity Failed
```bash
# Backup and reset
mv ~/.astrid/audit_chain.json ~/.astrid/audit_chain.json.bak

# Restart backend to create fresh chain
npm run daemon:start
```

---

## File Reference

| File | Purpose | Lines |
|------|---------|-------|
| `server/terminalView.ts` | Color-coded terminal UI | 280 |
| `server/eventInterceptor.ts` | Event routing & HITL | 140 |
| `capsule/src/lib.rs` | Main capsule orchestrator | 220 |
| `capsule/src/policy.rs` | Policy loading/management | 120 |
| `capsule/src/evaluator.rs` | 4-rule anomaly detection | 185 |
| `capsule/src/audit.rs` | Chain-linked audit logs | 165 |
| `scripts/asguard.sh` | CLI wrapper (6 commands) | 260 |
| `install.sh` | Automated setup | 180 |
| `PHASE4_DAEMON_INTEGRATION.md` | Full documentation | 600+ |

---

## Next Steps

1. ✅ Run `./install.sh`
2. ✅ Start services: `npm run daemon:start`
3. ✅ Open dashboard: `http://localhost:3000`
4. ✅ Test anomaly: Send sample tool call
5. ✅ Respond to HITL prompt
6. ✅ Export audit: `asguard audit export`

---

## Support

- **Full Docs**: See `PHASE4_DAEMON_INTEGRATION.md`
- **CLI Help**: `asguard help`
- **API Health**: `curl http://localhost:8080/api/health`
- **Terminal Colors**: Automatic (no config needed)

**Status: Phase 4 Complete** ✅

All systems ready for local daemon integration!
