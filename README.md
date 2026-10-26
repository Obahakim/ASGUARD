# ASGUARD

ASGUARD is a non-custodial approval control plane for agent initiated value movement. It evaluates and records requests before a host wallet or runtime signs or submits them. ASGUARD never accepts private keys or seed phrases, signs transactions, runs a solver, or relays NEAR Intents.

## Security flow

The host submits an exact payload and its execution domain. ASGUARD canonicalizes supported NEAR Intents, checks policy, risk, and fresh verified USD pricing, and returns an approval, a pending human decision, or a denial. Approval responses contain a short lived HMAC attestation bound to the payload hash, agent, network, domain, and where relevant the signer contract and derivation path. The host must verify it immediately before invoking its own signer. Timeouts and unavailable human review deny. Unknown execution targets require human approval.

ASGUARD uses symmetric HMAC attestations. The host verifier therefore needs the audit signing secret; protect it as a signing credential and rotate it with an explicit maintenance window. Deploy ASGUARD and host signers in trusted environments, restrict credentials by role, use TLS at the deployment boundary, and never put secrets in browser code or logs.

## NEAR paths

NEAR Intents are the primary approval path. The decoder accepts the normalized `asguard.near-intent.v1` form and the supported signed MultiPayload form. It rejects unsupported or ambiguous payloads. Its preflight is structured decode, exact canonical hash binding, policy evaluation, and fresh token price verification. It does not simulate NEAR execution and does not claim chain simulation. Missing or stale price data routes to HITL; it never trusts a caller supplied USD estimate for automatic approval.

Chain Signatures are secondary. The request binds the unsigned payload hash, target network, derivation path, and configured signer contract. Foreign chain risk defaults to HITL. ASGUARD does not call the signer contract.

There is no Solana send or simulation adapter in the active API. Non-NEAR target requests use approval-only mode and require HITL.

## Host verification

Import `withApprovedNearIntent` or `withApprovedChainSignature` from `server/approvalAttestation.ts` in a trusted host service. Pass the exact payload and expected agent, network, and domain bindings. The callback only runs after signature, expiry, payload hash, and binding checks pass. Keep signing inside that callback in the host. Never expose the signing key to browser JavaScript.

## API and MCP

REST and MCP use the same approval pipeline. Runtime credentials may request approvals and report activity. `admin` can update policy and make operator decisions; `operator` can make human decisions; `auditor` can read status, policy, intents, and audit records. Sensitive endpoints require bearer credentials. MCP approval tools include `asguard_request_near_intent_approval`, `asguard_request_chain_signature_approval`, and `asguard_get_approval_status`; read tools expose transaction status, policy, and health. REST endpoints include `/api/approvals/near-intent`, `/api/approvals/chain-signature`, `/api/transactions`, `/api/policy`, `/api/health`, and `/api/anomaly/audit-trail`.

## Configuration

Copy `.env.example` to `.env`, generate independent high entropy API tokens and an audit key of at least 32 bytes, and set the dashboard origin. The backend fails startup when credentials or the audit key are missing or invalid. Keep `.env` out of source control. Configure the NEAR network, HTTPS RPC, Intents token API, verifier, and Chain Signatures contract for the intended deployment. The default is NEAR testnet.

The audit chain, policy, profiles, and transaction intents use atomic local JSON persistence by default under `~/.astrid`; audit, profile, and intent paths can be redirected with their corresponding `ASGUARD_*_PATH` variables. Back up this directory using a consistent filesystem snapshot, verify audit integrity after restore, and retain the audit key securely: without the original key, existing HMAC entries cannot be verified.

## Run locally

```sh
npm install
npm run dev:backend
npm run dev:frontend
npm test
npm run build
npm run demo:near
```

Set a runtime credential for `demo:near`, and an admin/operator credential to resolve HITL in the dashboard. The demo exercises request, approval, and host verification only; it stops before signing or submission. Tests use temporary paths and do not contact production services.

## Operations

1. Provision credentials per service and role. Rotate credentials by overlapping old and new tokens, then remove the old token.
2. Back up policy, profiles, intents, and audit files using filesystem snapshots that preserve permissions. Back up Postgres separately when enabled.
3. On restore, start with the same audit key and confirm `/api/anomaly/diagnostics` reports a valid chain before allowing requests.
4. Monitor `/api/health`, audit chain diagnostics, pending HITL age, and denied requests. A failed NEAR RPC health check is surfaced as unhealthy; approval preflight still fails closed on unavailable price data.
5. Treat any audit integrity failure as a security incident. Preserve the original files and key for investigation; do not recreate an empty chain over them.

## Scope

ASGUARD is an approval and audit control plane. It is not a wallet, key custodian, signer, relayer, solver, NEAR Intents implementation, Chain Signatures MPC implementation, or chain execution simulator for NEAR. Its attestations authorize a host to proceed; they do not guarantee transaction success or replace host verification.
