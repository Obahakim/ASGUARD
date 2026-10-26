# ASGUARD

ASGUARD is a non-custodial approval and audit control plane for agent value movement on NEAR. Agents submit the exact unsigned payload, wait for a decision, and verify a short-lived attestation in their trusted host before that host may sign or submit. ASGUARD never accepts keys or seed phrases, signs, submits Intents, runs a solver, relays transactions, or calls Chain Signatures MPC.

## Security flow

`agent/host → ASGUARD policy + preflight → approved attestation | pending HITL | denied → host verifies → host callback may sign/submit`

Timeouts deny. Rejected, blocked, malformed, expired, or unverifiable requests never reach the host callback. Attestations bind the exact payload hash, agent, network/domain, and Chain Signatures derivation path and signer contract where applicable. Use TLS outside local development, distinct high-entropy runtime/admin credentials, and keep the HMAC audit key only in trusted server-side environments.

## NEAR approval paths

NEAR Intents are the primary path. Preflight strictly decodes supported payloads, canonicalizes and hashes execution fields, evaluates asset/destination/intent policy and time/slippage constraints, and checks verified fresh USD prices. Missing or stale prices require HITL. This is preflight; ASGUARD does not run a NEAR VM or claim chain simulation.

Chain Signatures approval is secondary. It binds unsigned payload bytes, target network, derivation path, and configured signer contract; foreign-chain targets require HITL. Unknown targets are approval-only and require HITL. There is no active Solana path.

## Agent SDK (mandatory host pattern)

Install/use the repository package subpath `asguard/agent-sdk` from a trusted Node.js host. Put all host signing/submission work inside the callback. See [agent-sdk/README.md](agent-sdk/README.md) for NEAR Intent and Chain Signatures examples, option requirements, and wrong/right patterns. The helper polls HITL, fails closed on timeout/rejection, verifies signature, expiry, hash and bindings, then invokes the callback. Never import it into browser code or catch an approval failure and continue to sign.

## API and MCP

REST and MCP expose NEAR Intent and Chain Signature approval requests, approval status, transaction intents, policy, health, and audit diagnostics. Wallet watch exposes `asguard_watch_near_wallet`, `asguard_list_watched_wallets`, and `asguard_get_wallet_activity`. Runtime credentials request approvals and register watches; admin/operator credentials resolve HITL and manage policy/watches; auditor credentials are read-only. Sensitive API routes are role-gated. There is no Postgres backend; durable state uses atomic local JSON files.

## Configuration

Copy `.env.example` to `.env`. Replace every credential example with independent random values; `ASGUARD_API_CREDENTIALS` and `ASGUARD_AUDIT_KEY` are required and startup fails if missing or weak. Configure `ASGUARD_NEAR_NETWORK`, HTTPS `ASGUARD_NEAR_RPC_URL`, Intents verifier/API, and signer contract for the deployment. Testnet is the default. Set `ASGUARD_ALLOWED_ORIGINS` to dashboard origins. Use the actual configured paths and polling interval shown in `.env.example`; no database configuration is used.

## Run locally

```sh
npm install
npm run dev:backend
npm run dev:frontend
npm test
npm run build
```

The backend is `http://localhost:8080` and dashboard is `http://localhost:3000` by default. Authenticate the dashboard with an admin/operator credential.

## Demo for judges

Start the backend and frontend, then use the dashboard’s **Approvals** tab to resolve HITL requests. Configure `.env` with valid local runtime and operator credentials first.

| Command | Demonstrates |
| --- | --- |
| `npm run demo:near:approve` | Low-risk NEAR Intent request and verified host callback; stops before signing/submitting. |
| `npm run demo:near:hitl` | High-risk request; shows request ID and waits for dashboard decision. |
| `npm run demo:near:block` | Expired intent rejection and preflight reason. |
| `npm run demo:near` | Runs the low-risk approval path. |
| `npm run demo:agent-guard` | Pending/deny blocks and approval+verification invokes a callback with no real signing. |
| `npm run demo:watch` | Registers `ASGUARD_WATCH_DEMO_ACCOUNT`, then shows observed activity (if any) from the public RPC. |

Each script prints request/status/preflight context and fails clearly when credentials or the backend are unavailable. No demo submits a real transaction.

## Wallet watch

Wallet watch is secondary, read-only monitoring for registered public NEAR accounts. It stores account, agent, network, label, active state, timestamps, and bounded observed activity in atomic JSON (`ASGUARD_WATCHED_WALLETS_PATH`). The poller checks finalized public blocks over configured HTTPS NEAR RPC, backs off after failures, reports degraded health, and audits observed activity and watcher errors. It does not block chain execution or claim that every event can be attributed to an ASGUARD approval. The dashboard’s **Wallet Watch** tab shows registered accounts, poller health, and observed activity; an empty activity list is a valid state.

## Operations

Persisted audit, policy, agent profiles, transaction intents, and wallet watches default under `~/.astrid` (or configured `ASGUARD_*_PATH`). Back up the directory with a consistent filesystem snapshot and restrictive permissions. Keep the audit key separate from backups; restoring the original key is required to verify existing HMAC audit entries. Rotate the audit key only with a planned maintenance procedure and archive the old key securely for historical verification. Startup verifies the audit chain and rejects tampering. Monitor `/api/health`, audit diagnostics, pending HITL age, and wallet-watch health. `/api/health` reflects configured NEAR RPC and watcher health.

## Scope

ASGUARD is not a wallet, key custodian, relayer, solver, transaction executor, Intents implementation, Chain Signatures MPC implementation, or NEAR execution simulator. Attestation means the host may proceed only after its own verification; it does not guarantee transaction success.
