# Asguard Phase 3: Anomaly Detection Engine

## Overview

Phase 3 implements a sophisticated anomaly detection system with:
- **4 Detection Rules**: IP/Device breach, Budget overrun, Frequency spike, Unverified contracts
- **Behavioral Profiling**: Exponential moving average baselines per agent
- **Cryptographic Audit Chain**: HMAC-SHA256 signed, chain-linked logs
- **Contract Validation**: Bytecode verification against known contracts
- **Risk Scoring**: 0-100 scale with thresholds for silent_pass, warn, halt_and_hitl

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                  Asguard Dashboard (Frontend)               │
└────────────────────┬────────────────────────────────────────┘
                     │ WebSocket / REST
                     ▼
┌─────────────────────────────────────────────────────────────┐
│               Express Server (localhost:8080)               │
├─────────────────────────────────────────────────────────────┤
│  Agent Activity Endpoint (/api/events/agent-activity)       │
│         ▼                                                    │
│  ┌──────────────────────────────────────────┐              │
│  │      Anomaly Engine (Orchestrator)       │              │
│  ├──────────────────────────────────────────┤              │
│  │  processActivity()                       │              │
│  │    1. Update ProfileManager              │              │
│  │    2. Run Evaluator (4 rules)            │              │
│  │    3. Add AuditChain entry               │              │
│  │    4. Determine HITL trigger             │              │
│  │    5. Return EvaluationResult            │              │
│  └──────────────────────────────────────────┘              │
│         │          │          │          │                 │
│         ▼          ▼          ▼          ▼                 │
│    ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────────┐      │
│    │Profile │ │Evaluator│ │Audit  │ │Contract      │      │
│    │Manager │ │(4 rules)│ │Chain  │ │Validator     │      │
│    └────────┘ └────────┘ └────────┘ └──────────────┘      │
│         ▲          ▲          ▲          ▲                 │
│         └──────────┴──────────┴──────────┘                 │
│           Broadcast Events → Bridge → Dashboard            │
└─────────────────────────────────────────────────────────────┘
```

## Components

### 1. ProfileManager (`server/profileManager.ts`)

Maintains behavioral baselines for each agent.

**Key Methods:**
- `getProfile(agentId)` - Get or create agent profile
- `updateProfile(activity, metadata)` - Update baseline with new activity
- `isProfileMature(agentId)` - Check if profile has MIN_OBSERVATIONS (5)
- `getFrequencyMultiplier(agentId)` - Get baseline frequency
- `getBaselineStats(agentId)` - Export profile data
- `resetProfile(agentId)` - Clear profile for agent

**Profile Data:**
```typescript
{
  agent_id: string;
  baseline_trade_frequency: number;      // Trades per hour (EMA)
  baseline_avg_amount_usd: number;       // Average trade amount (EMA)
  baseline_ips: Set<string>;             // Known IP addresses
  baseline_devices: Set<string>;         // Known device IDs
  observation_count: number;             // Total activities tracked
  first_seen: Date;
  last_updated: Date;
}
```

**Algorithm:** Exponential Moving Average (α=0.3)
- Smooths baseline estimates to catch real shifts, not noise
- Frequency updates: `frequency = α*1 + (1-α)*baseline`
- Amount updates: `avg = α*amount + (1-α)*baseline_avg`

---

### 2. Evaluator (`server/evaluator.ts`)

Applies 4 detection rules with scoring.

**Rules:**

#### Rule 1: IP/Device Breach (HIGH severity, 40-35 points)
- Detects logins from unknown locations
- Tracks baseline IPs and devices
- Triggered when new IP/device seen and baseline exists
- Points: 40 (new IP), 35 (new device)

#### Rule 2: Budget Overrun (HIGH severity, 50 points)
- Detects trades exceeding `policy.max_auto_trade_usd`
- Hard limit enforcement
- Points: 50 (always high impact)

#### Rule 3: Frequency Spike (MEDIUM severity, 30 points)
- Detects trading frequency 300%+ above baseline
- Requires mature profile
- Points: 30 (medium priority)

#### Rule 4: Unverified Contract (HIGH severity, 45 points)
- Detects interaction with unwhitelisted contracts
- Uses ContractValidator for verification
- Points: 45 (high risk due to unknown code)

**Scoring:**
```
Total Score = Σ rule_contributions (capped at 100)

Score Ranges:
  0-39:   silent_pass    (confidence: 100%)
 40-69:   warn           (confidence: 85%)
 70-100:  halt_and_hitl  (confidence: 95%)
```

---

### 3. ContractValidator (`server/contractValidator.ts`)

Validates smart contract bytecode.

**Key Methods:**
- `validateContract(address)` - Verify contract
- `cacheBytecode(address, bytecode)` - Store bytecode
- `invalidateVerification(address)` - Mark as unverified
- `validateMultiple(addresses)` - Batch verify
- `getStats()` - Cache statistics

**Verification Logic:**
1. Check well-known contract whitelist (USDC, USDT, WBTC)
2. Compare bytecode SHA256 hash against known signatures
3. Trust score: 100 (whitelist), 75 (verified hash), 0 (unverified)

---

### 4. AuditChain (`server/auditChain.ts`)

Cryptographically signed, chain-linked audit logs.

**Key Methods:**
- `addEntry(eventId, agentId, action, score)` - Add signed entry
- `verifyChainIntegrity()` - Detect tampering
- `getEntriesForAgent(agentId)` - Agent history
- `getEntriesByTimeRange(start, end)` - Time range query
- `exportChain()` - Full chain export
- `getStats()` - Chain health

**Chain Entry:**
```typescript
{
  sequence_number: number;          // Monotonic sequence
  timestamp: string;                // ISO timestamp
  event_id: string;                 // Event reference
  agent_id: string;
  action: string;
  anomaly_score?: number;           // Score from Evaluator
  previous_hash: string;            // Link to previous entry
  entry_hash: string;               // SHA256 of entry
  signature: string;                // HMAC-SHA256 signature
}
```

**Integrity Verification:**
- Chain links: `entry.previous_hash == last_entry.entry_hash`
- Entry hash: `SHA256(JSON.stringify(entry_data))`
- Signature: `HMAC-SHA256(entry_hash + previous_hash, signing_key)`
- Tampering immediately breaks chain validation

---

### 5. AnomalyEngine (`server/anomalyEngine.ts`)

Orchestrator that coordinates all components.

**Key Methods:**
- `processActivity(activity, metadata, policy)` - Run detection pipeline
- `getDiagnostics()` - Get system stats
- `getAgentProfile(agentId)` - Get baseline
- `resetAgentProfile(agentId)` - Clear profile
- `verifyAuditChain()` - Check integrity
- `exportAuditTrail()` - Compliance export

**Return from processActivity():**
```typescript
{
  evaluation: EvaluationResult,      // Score & rules triggered
  should_trigger_hitl: boolean,      // If score >= 70
  anomaly_event?: AnomalyDetectionEvent
}
```

---

## API Endpoints (Phase 3)

### POST `/api/events/agent-activity`

Process agent activity with anomaly detection.

**Request:**
```json
{
  "agent_id": "trader-bot-01",
  "agent_name": "Trader Bot",
  "action": "execute_trade",
  "risk_level": "medium",
  "details": { "strategy": "grid" },
  "amount_usd": 50000,
  "ip_address": "192.168.1.100",
  "device_id": "device-01",
  "contract_address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
}
```

**Response:**
```json
{
  "success": true,
  "event": { ... },
  "anomaly": {
    "agent_id": "trader-bot-01",
    "anomaly_score": 45,
    "rules_triggered": [
      {
        "rule_id": "budget_overrun",
        "severity": "high",
        "score_contribution": 50,
        "details": { "amount": 50000, "max_allowed": 30000, "overage_percent": "66.7" }
      }
    ],
    "action": "warn",
    "confidence": 85
  },
  "hitl_triggered": false
}
```

### GET `/api/anomaly/diagnostics`

Get anomaly engine health.

**Response:**
```json
{
  "success": true,
  "diagnostics": {
    "profiles": {
      "total_profiles": 3,
      "mature_profiles": 2,
      "total_observations": 156
    },
    "audit_chain": {
      "total_entries": 50,
      "chain_valid": true,
      "last_entry": "2024-07-21T14:32:18.000Z"
    },
    "contracts": {
      "total_checked": 5,
      "verified": 4,
      "unverified": 1,
      "cache_size": 5
    }
  },
  "audit_chain_valid": true
}
```

### GET `/api/anomaly/profile/:agent_id`

Get agent behavioral baseline.

**Response:**
```json
{
  "success": true,
  "agent_id": "trader-bot-01",
  "profile": {
    "trade_frequency": 2.4,
    "avg_amount_usd": 12500,
    "known_ips": ["192.168.1.100", "10.0.0.50"],
    "known_devices": ["device-01"],
    "observations": 42,
    "mature": true
  }
}
```

### POST `/api/anomaly/profile/:agent_id/reset`

Reset agent profile after alert resolution.

### GET `/api/anomaly/audit-trail`

Export full audit chain for compliance.

---

## Integration with Existing Systems

### PolicyStore
- Policies control whether anomaly detection is enabled
- `policy.strict_anomaly_detection`: master toggle
- `policy.max_auto_trade_usd`: budget overrun threshold
- `policy.device_ip_lock`: IP/device breach detection
- Evaluator checks all policies before scoring

### Bridge (WebSocket)
- Broadcasts `anomaly_detected` events to dashboard
- Streams anomaly scores real-time
- HITL requests trigger interactive prompts

### HITLHandler
- Triggered when `anomaly_score >= 70`
- User approves/denies via terminal or dashboard
- Decision added to audit chain

### Logger
- Colored terminal output for each rule violation
- Event broadcasting with classification
- Log history with export

---

## Scoring Examples

### Example 1: New IP + Budget Overrun
```
Agent: trader-bot-01
Activity: Trade $60,000 from 203.0.113.25

Rules Triggered:
  - Budget Overrun: score +50 ($60K > $50K limit)
  - IP Breach: score +40 (new IP, baseline exists)

Total Score: 90
Action: halt_and_hitl ← HITL triggered
```

### Example 2: Normal Activity
```
Agent: trader-bot-01
Activity: Trade $5,000 from 192.168.1.100

Rules Triggered: none

Total Score: 0
Action: silent_pass ← No alerts
```

### Example 3: Frequency Spike
```
Agent: trader-bot-02
Baseline Frequency: 1 trade/hour
Current: 4 trades in 1 hour (4x spike)

Rules Triggered:
  - Frequency Spike: score +30 (>300% above baseline)

Total Score: 30
Action: silent_pass ← Below warn threshold
(But logged and available to operator)
```

---

## Testing the Engine

### 1. Test Agent Activity Endpoint
```bash
curl -X POST http://localhost:8080/api/events/agent-activity \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "test-agent",
    "agent_name": "Test",
    "action": "trade",
    "risk_level": "high",
    "amount_usd": 100000,
    "ip_address": "203.0.113.1",
    "contract_address": "0xUnknownContract"
  }'
```

### 2. Verify Anomaly Detection
- Watch WebSocket stream for `anomaly_detected` events
- Check terminal for colored rule violations
- Terminal prompt should appear if HITL triggered

### 3. Check Audit Chain
```bash
curl http://localhost:8080/api/anomaly/audit-trail | jq '.entries[] | {sequence: .sequence_number, action: .action, score: .anomaly_score}'
```

### 4. Export for Compliance
```bash
curl http://localhost:8080/api/anomaly/audit-trail > audit_export.json
# Verify chain integrity in JSON
```

---

## Performance Notes

- **Profile Updates**: O(1), exponential moving average
- **Rule Evaluation**: O(1) per rule, ~10ms total
- **Contract Validation**: O(1) with caching, network calls in production
- **Audit Chain**: O(n) for integrity check, but only on demand
- **Memory**: ~5KB per agent profile, scales linearly

---

## Security Considerations

1. **Signing Key**: `ASGUARD_AUDIT_KEY` env var (change in production)
2. **Audit Chain**: Tamper-evident via HMAC verification
3. **Policy Enforcement**: All rules respect `strict_anomaly_detection`
4. **Bytecode Hashing**: SHA256, resistant to collisions
5. **HITL Integration**: User decisions recorded in audit chain

---

## Next Steps (Phase 4+)

1. **Integration with astridd**:
   - Real-time event stream from daemon
   - Enforcement: block trades based on HITL decisions
   - Agent capability checks

2. **Machine Learning**:
   - Anomaly score weighting per agent type
   - Clustering-based profile clustering
   - Seasonal adjustments

3. **Audit Dashboard**:
   - Timeline visualization of rules triggered
   - Agent profile comparison
   - Chain integrity status

4. **Compliance Export**:
   - Signed audit trail in compliance format
   - Merkle proof generation
   - Third-party verification

