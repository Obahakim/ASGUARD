# ASGUARD

ASGUARD is a non-custodial pre-approval layer: a second pair of eyes for agents that move value. It evaluates a proposed action before the host's local signer or runtime executes it. ASGUARD never receives seed phrases or private keys, never signs, and never replaces a wallet, NEAR Intents, Chain Signatures, or a solver.

## Security Flow

```text
Agent proposes a NEAR Intent or Chain Signature payload
  -> ASGUARD canonicalizes and binds the exact payload hash
  -> policy and anomaly evaluation
  -> approved + short-lived attestation | pending HITL | rejected/blocked
  -> host verifies the attestation and its domain/network/path
  -> host signer or NEAR Intents integration may continue
```

High/critical risk, unknown value, unlisted targets, and unsupported execution targets require human review. Explicit denies, budget violations, excessive slippage, expired intents, and time-window violations are blocked. HITL timeouts deny. Only the host can sign or submit, and it must verify the attestation immediately before doing so.

## NEAR Integration

The primary path is approval for a canonical NEAR Intent. ASGUARD accepts either the normalized `asguard.near-intent.v1` fields or a NEAR signed MultiPayload envelope (`standard` + `payload`). The current decoder supports exactly one `token_diff` with one negative input and one positive output. It extracts asset IDs, smallest-unit amounts, deadline, recipient/chain metadata when available, and slippage metadata. Unsupported or ambiguous payload shapes fail closed. The complete envelope, including the original message bytes, is included in the canonical hash.

For NEAR Intents signed-payload execution, the host should obtain/build the intent, ask ASGUARD for approval, then call `withApprovedNearIntent` with the exact intent and expected agent/network/verifier. The callback runs only after verification and receives both the canonical bytes and untouched original payload; the host then signs and submits through its chosen NEAR integration. ASGUARD does not call `generate-intent` or `submit-intent`.

Chain Signatures is the secondary path. The host sends the unsigned foreign-chain payload hash, target network, and derivation path to ASGUARD, then calls `withApprovedChainSignature` with the expected signer contract. Its callback runs only after verification and is where the host may request the MPC signature. ASGUARD never calls the signer contract. Unknown targets are approval-only and require HITL; optional chain adapters may add safe simulation/decoding when explicitly registered.

The default registry is NEAR. The legacy Solana devnet adapter is disabled unless `ASGUARD_ENABLE_SOLANA_ADAPTER=true`; it is compatibility code, not the primary path.

## Policy and Anomaly Controls

The existing policy model remains, including `max_auto_trade_usd`, strict anomaly detection, device/IP checks, and remote-trigger protection. NEAR-specific fields add:

- `allowed_intent_types` / `denied_intent_types`
- `allowed_assets` / `denied_assets`
- `allowed_destinations` / `denied_destinations`
- `allowed_intent_chains` / `denied_intent_chains`
- `max_slippage_bps`
- `allowed_intent_hours_utc`
- `intent_unknown_target_requires_hitl`

An empty allow-list does not mean unrestricted auto-approval: it requires HITL. Explicit deny-lists and hard limits block. USD budget evaluation uses the NEAR Intents token feed only when the price is fresh; missing or stale pricing requires HITL. Agent-declared `amount_usd` is not trusted for auto-approval.

The anomaly pipeline preserves the LOW (0-39), ELEVATED (40-69), HIGH (70-89), and CRITICAL (90-100) bands, behavioral baselines, frequency checks, device/IP checks, and notifications for unresolved high-severity requests. Every control-plane event is written to the same durable HMAC-linked audit chain; no external anchoring is claimed.

## API and MCP

Runtime credentials use `ASGUARD_API_CREDENTIALS` with the existing `runtime`, `admin`, `operator`, and `auditor` roles. MCP and REST approval requests require `runtime` or `admin`; HITL decisions and policy edits are role-gated.

Primary MCP tools:

- `asguard_request_near_intent_approval`
- `asguard_request_chain_signature_approval`
- `asguard_get_approval_status`
- `asguard_get_transaction_status`
- `asguard_get_policy`
- `asguard_get_status`
- `asguard_report_activity`
- `asguard_report_security_violation`

REST approval endpoints are `POST /api/approvals/near-intent` and `POST /api/approvals/chain-signature`. The dashboard exposes live approvals, risk context, policy lists, transaction intents, and audit events over authenticated HTTP/WebSocket connections.

## Local Development

1. Copy `.env.example` to `.env` and replace the credential placeholders with distinct random values. Never commit `.env` or share its contents.
2. Start the backend with `npm run backend:start`; start the frontend with `npm run dev:frontend`.
3. Connect the dashboard with an admin or operator API credential.
4. Run `npm run demo:near` to request approval for a sample NEAR token-diff intent, handle HITL in the dashboard if required, and exercise the verified host callback. The demo intentionally stops before wallet signing or submission.

The sample config defaults to NEAR testnet RPC for health checks. NEAR Intents may have different network availability; configure and verify the host integration's target network independently. `ASGUARD_NEAR_INTENTS_API_URL`, `ASGUARD_NEAR_INTENTS_VERIFIER`, and `ASGUARD_NEAR_CHAIN_SIGNATURES_CONTRACT` describe integration context only; they do not enable custody or execution.

## Storage and Limits

Policy, the HMAC-linked audit chain, transaction intents, and agent behavior profiles are local-file backed. Transaction intents may additionally be written to Postgres when configured; profile persistence is pluggable behind an interface. The Rust/WASM capsule exports remain a prototype stub and are not the active enforcement hook. Treat ASGUARD as a control-plane prototype until the host integration is deployed and independently security reviewed.