# ASGUARD demo guide

The demo commands exercise the local approval API and stop at host-side approval verification. They never accept a wallet key, sign, or submit a transaction.

## Setup

1. Use Node.js 20.9 or newer and run `npm install`.
2. Copy `.env.example` to `.env`. Generate independent random values for each API token and `ASGUARD_AUDIT_KEY`:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

   Configure at least one `runtime` credential and one `admin` or `operator` credential. Keep `ASGUARD_NEAR_NETWORK=testnet`.
3. Start `npm run dev:backend` and `npm run dev:frontend` in separate terminals. Resolve HITL requests in the dashboard's **Approvals** tab.
4. For wallet-watch only, set `ASGUARD_WATCH_DEMO_ACCOUNT` to a public NEAR testnet account ID. It is read-only; never enter a private key or seed phrase.

The scripts authenticate against `/api/policy` before running. Missing or weak credentials, an unreachable backend, or a non-testnet network fail before a demo request is sent. Low-risk intents can still require HITL when fresh verified price data or policy allowlists are unavailable; this is the intended fail-closed behavior.

## Multi-scenario suite

Run several built-in scenarios sequentially:

```sh
npm run demo:suite -- --scenario approve --scenario hitl --scenario block
```

Or run a scenario file with distinct intent payloads, risk levels, and outcomes:

```sh
npm run demo:suite -- --file scripts/demo-scenarios.example.json
```

A scenario file has a top-level `scenarios` array. Each entry supports:

- `name`: readable label.
- `mode`: `approve`, `hitl`, or `block`.
- `riskLevel`: optional `low`, `medium`, `high`, or `critical` (defaults to `high` for HITL and `low` otherwise).
- `agentId`: optional per-scenario agent ID.
- `intent`: optional NEAR Intent object. Omitted fields use the local demo defaults. A `block` scenario intentionally replaces its deadline with a fixed expired date.

For example:

```json
{
  "scenarios": [
    {
      "name": "small-swap",
      "mode": "approve",
      "riskLevel": "low",
      "intent": {
        "intent_type": "token_diff",
        "origin_asset": "nep141:wrap.near",
        "destination_asset": "nep141:usdt.tether-token.near",
        "amount": "1000000000000000000000000",
        "recipient": "demo.near",
        "destination_chain": "near",
        "max_slippage_bps": 50
      }
    },
    {
      "name": "operator-reviewed-transfer",
      "mode": "hitl",
      "riskLevel": "high",
      "intent": {
        "intent_type": "token_diff",
        "origin_asset": "nep141:wrap.near",
        "destination_asset": "nep141:usdc.near",
        "amount": "2000000000000000000000000",
        "recipient": "review.near",
        "destination_chain": "near",
        "max_slippage_bps": 150,
        "quote_id": "local-demo-quote"
      }
    }
  ]
}
```

Scenarios run in order; an HITL request waits up to three minutes for a dashboard decision before the suite continues. A denied or timed-out request does not invoke the host callback. Each run uses fresh idempotency keys so local JSON history from an earlier run cannot make a repeat look like a new approval. Payload fields and outcome expectations are stable for the same scenario and policy.

`mode: "block"` submits an expired unsigned intent and expects ASGUARD to reject it during decoding. `mode: "approve"` verifies the approval attestation and calls a no-op host callback. `mode: "hitl"` requests a dashboard decision and only reaches that callback if an operator approves. None of these modes signs or submits.
