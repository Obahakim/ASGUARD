# ASGUARD demo guide

The default demo commands exercise the local approval API and stop at host-side approval verification. Tidepool has a separate optional host-side settlement flow that is disabled unless explicitly enabled; the ASGUARD backend never receives its wallet key and never signs or submits.

## Setup

1. Use Node.js 20.9 or newer and run `npm install`.
2. Copy `.env.example` to `.env`. Generate independent random values for each API token and `ASGUARD_AUDIT_KEY` (the audit key is not an approval signing key):

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

  Configure at least one `runtime` credential and one `admin` or `operator` credential. Generate the Ed25519 key pair using the command in the README Configuration section, keep the private key server-side, and make the public key available to the demo host. Keep `ASGUARD_NEAR_NETWORK=testnet`.
3. Start `npm run dev:backend` and `npm run dev:frontend` in separate terminals. Resolve HITL requests in the dashboard's **Approvals** tab.
4. For wallet-watch only, set `ASGUARD_WATCH_DEMO_ACCOUNT` to a public NEAR testnet account ID. It is read-only; never enter a private key or seed phrase.
5. The optional `demo:near:approve:submit` command requires `ASGUARD_DEMO_SUBMIT=true`, a funded NEAR testnet demo account, a public testnet recipient, and a tiny amount no greater than `0.01` NEAR. Its private key is read from local `.env` by the host demo only and is removed before backend startup. The host verifies approval before signing; ASGUARD only records the reported transaction hash.

The demo requires `ASGUARD_DEMO_NEAR_ACCOUNT_ID`, `ASGUARD_DEMO_NEAR_PRIVATE_KEY`, `ASGUARD_DEMO_NEAR_RECIPIENT`, and optionally `ASGUARD_DEMO_NEAR_AMOUNT` (default `0.001`). Never use a mainnet key. A pending transfer requires an operator decision in the dashboard; rejection and timeout do not reach the host signing callback.

The scripts authenticate against `/api/policy` before running. Missing or weak credentials, an unreachable backend, or a non-testnet network fail before a demo request is sent. Low-risk intents can still require HITL when fresh verified price data or policy allowlists are unavailable; this is the intended fail-closed behavior.

## Tidepool testnet Intents swap

Tidepool is a free community-built, 1Click-compatible **testnet** sandbox, not affiliated with NEAR, Defuse, or 1Click. Without opting into the Tidepool demo wallet, setup and `.env.example` use official 1Click at `https://1click.chaindefuser.com` with verifier `intents.near`. On testnet, opting into the Tidepool demo wallet switches to `https://www.usetidepool.tech` with verifier `verifier.tidepool-sandbox.testnet`; Tidepool approval-only demos require that URL/verifier pair. Mainnet always uses official 1Click and `intents.near`. ASGUARD approves and verifies payloads; it does not run the Tidepool solver.

With services running and the dashboard ready for HITL, run:

```sh
npm run demo:near:tidepool:approve
npm run demo:near:tidepool:tamper
```

Both commands request a live Tidepool quote, obtain its exact `swap_transfer` intent payload, bind that payload and quote signature into ASGUARD’s near-intent approval, and register the public demo account with `connectAgent`. The first command is approval-only by default: it does not sign, submit, or move tokens. The tamper command gets approval for payload A, changes its amount and signed intent to payload B, then re-verifies B against A’s attestation. It must print `attestation/payload binding rejected change after approval`; it never signs or submits, even if settlement is enabled.

For an actual testnet settlement, create/use a NEAR implicit account and add these host-only values to `.env`:

```dotenv
ASGUARD_DEMO_TIDEPOOL_SETTLE=true
ASGUARD_DEMO_TIDEPOOL_ACCOUNT_ID=<64-character lowercase hex public-key account ID>
ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY=ed25519:<base58 NEAR secret key>
```

The account ID must be the public key encoded as 64 lowercase hex characters and match the private key. The approval demo is capped at $2 and requests a 0.1 USDC swap. Optionally set `ASGUARD_DEMO_TIDEPOOL_FAUCET=true` to request Tidepool’s `mode: intents` USDC drip before the swap (Tidepool limits faucet use). Otherwise, fund that account’s Intents balance through Tidepool first. The host waits for a dashboard decision, verifies the attestation again, signs Tidepool’s generated raw Ed25519 payload locally, submits it to Tidepool, then polls for final status and an explorer link. The backend strips `ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY` at startup. Never use a mainnet key; the demo refuses mainnet and refuses a non-Tidepool endpoint.

Tidepool test tokens have no value. Tidepool operates the testnet maker/solver and bridge relayer; those are external to ASGUARD. If Tidepool is unavailable, the demo prints a clear error while the core ASGUARD server continues to run.

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
