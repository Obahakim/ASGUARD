# ASGUARD

ASGUARD is a non-custodial approval and audit control plane for agent value movement on NEAR. Agents submit the exact unsigned payload, wait for a decision, and verify a short-lived Ed25519 attestation in their trusted host before that host may sign or submit. ASGUARD never accepts keys or seed phrases, signs or submits on-chain transactions or Intents, runs a solver, relays transactions, or calls Chain Signatures MPC.

## Security flow

`agent/host → ASGUARD policy + preflight → approved attestation | pending HITL | denied → host verifies → host callback may sign/submit`

Timeouts deny. Rejected, blocked, malformed, expired, or unverifiable requests never reach the host callback. Ed25519 attestations bind the exact payload hash, agent, network/domain, and Chain Signatures derivation path and signer contract where applicable. ASGUARD keeps the attestation private key server-side; hosts receive only the public verification key. The separate HMAC audit key is server-side only and is never used to sign approvals. Use TLS outside local development and distinct high-entropy runtime/admin credentials.

## NEAR approval paths

NEAR Intents are the primary path. Preflight strictly decodes supported payloads, canonicalizes and hashes execution fields, evaluates asset/destination/intent policy and time/slippage constraints, and checks verified fresh USD prices. Missing or stale prices require HITL. This is preflight; ASGUARD does not run a NEAR VM or claim chain simulation.

Chain Signatures approval is secondary. It binds unsigned payload bytes, target network, derivation path, and configured signer contract; foreign-chain targets require HITL. Unknown targets are approval-only and require HITL. There is no active Solana path.

## Agent SDK (mandatory host pattern)

Install/use the repository package subpath `asguard/agent-sdk` from a trusted Node.js host. Put all host signing/submission work inside the callback. See [agent-sdk/README.md](agent-sdk/README.md) for NEAR Intent and Chain Signatures examples, option requirements, and wrong/right patterns. The helper polls HITL, fails closed on timeout/rejection, verifies signature, expiry, hash and bindings, then invokes the callback. Never import it into browser code or catch an approval failure and continue to sign.

## API and MCP

REST and MCP expose NEAR Intent and Chain Signature approval requests, approval status, transaction intents, policy, health, and audit diagnostics. Agents connect with `POST /api/agents/connect` or MCP `asguard_connect_agent`; the public NEAR accounts they declare are added to read-only wallet watch and the connection is audited. Wallet watch also exposes `asguard_watch_near_wallet`, `asguard_list_watched_wallets`, and `asguard_get_wallet_activity`. Runtime credentials request approvals and register watches; admin/operator credentials resolve HITL and manage policy/watches; auditor credentials are read-only. The host can report a completed testnet transaction to `POST /api/submissions/report`; ASGUARD validates the approved intent and exact payload hash but never signs or broadcasts. Sensitive API routes are role-gated. There is no Postgres backend; durable state uses atomic local JSON files.

## Configuration

Copy `.env.example` to `.env`. Configure separate runtime and admin/operator API tokens and an independent `ASGUARD_AUDIT_KEY`, each at least 32 bytes. This HMAC key is only for the audit chain. Generate an Ed25519 attestation key pair before startup; keep its private PEM on the server and provide only the public PEM to trusted hosts. The following creates ignored local-development key files without printing the private key:

```sh
node --input-type=module -e "import { generateKeyPairSync } from 'node:crypto'; import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('.asguard', { recursive: true }); const { privateKey, publicKey } = generateKeyPairSync('ed25519'); writeFileSync('.asguard/attestation-private.pem', privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 }); writeFileSync('.asguard/attestation-public.pem', publicKey.export({ type: 'spki', format: 'pem' }));"
```

The configured key paths must refer to this matching pair. The backend fails early if required credentials or keys are missing or invalid. Optional NEAR AI enrichment is disabled unless `ASGUARD_AI_ENABLED=true`; configure its API URL, key, and model in local `.env`. It adds summaries/signals to audit/UI only and cannot affect allow, HITL, or deny decisions. NEAR testnet is the default; demos refuse to run if `ASGUARD_NEAR_NETWORK` is not `testnet`. Demo commands clear inherited `ASGUARD_*` environment values before loading `.env`, so the local file is authoritative. Configure HTTPS NEAR endpoints and `ASGUARD_ALLOWED_ORIGINS` for your deployment. State is stored in local JSON files; no database configuration is used.

## Run locally

Use Node.js 20.9 or newer. After creating `.env` as described above, run:

```sh
npm install
npm run dev:backend
```

In a second terminal, start the dashboard:

```sh
npm run dev:frontend
```

The backend is `http://localhost:8080` and dashboard is `http://localhost:3000` by default. Authenticate the dashboard with an admin/operator credential.

## How to try it

Start both services as above and use **Approvals** in the dashboard when a request enters HITL. Each command prints its backend/network preflight and expected outcome:

1. `npm run demo:near:approve` → submits a low-risk unsigned testnet intent for preflight; see an approved status and verified callback, or resolve the request in the dashboard if policy or missing/stale price data requires HITL.
2. `npm run demo:near:hitl` → see a pending request ID; approve or deny it in **Approvals**. Only approval reaches the verified host callback.
3. `npm run demo:near:block` → see the expired intent rejected with its decode/preflight reason.
4. `npm run demo:agent-guard` → deny the first request and approve the second in **Approvals**; see denial block the callback and verified approval reach it.
5. Set `ASGUARD_WATCH_DEMO_ACCOUNT` to a public NEAR testnet account ID, then run `npm run demo:watch` → see the registered watch and activity history (an empty history is valid).
6. Optional tiny transfer proof: configure a funded NEAR testnet demo account and recipient in local `.env`, explicitly set `ASGUARD_DEMO_SUBMIT=true`, then run `npm run demo:near:approve:submit`. The host verifies the Ed25519 attestation, waits for HITL, sends at most `0.01 NEAR` on testnet, then reports its tx hash to ASGUARD. The backend never signs or broadcasts; the demo private key is removed before backend startup.

For real testnet Intents quotes, run `npm run demo:near:tidepool:approve`. Tidepool is a community-built 1Click-compatible testnet sandbox, unaffiliated with NEAR, Defuse, or 1Click; it uses `https://www.usetidepool.tech` and `verifier.tidepool-sandbox.testnet`. This command requests a live quote and ASGUARD approval but does not sign or settle by default. `npm run demo:near:tidepool:tamper` changes the approved payload and demonstrates the attestation binding rejection without submitting it. To settle the capped 0.1 USDC swap on testnet, explicitly set `ASGUARD_DEMO_TIDEPOOL_SETTLE=true` and provide the host-only implicit account ID and matching `ed25519:` private key documented in [docs/DEMO.md](docs/DEMO.md); optional `ASGUARD_DEMO_TIDEPOOL_FAUCET=true` requests Tidepool test tokens. The ASGUARD server never receives the key and does not run the solver.

The default demos stop before real signing or transaction submission; they use no configured wallet key or live fund movement. Missing/weak credentials, non-testnet configuration, or an unreachable backend fail with actionable instructions. Production mainnet configuration must switch back to official 1Click (`https://1click.chaindefuser.com`) and `intents.near`. For custom payloads and multi-scenario runs, see [docs/DEMO.md](docs/DEMO.md).

The existing `demo:near:approve:submit` transfer command is disabled unless `ASGUARD_DEMO_SUBMIT=true`, requires NEAR testnet, and sends at most `0.01 NEAR` from a host-side demo account after verified approval and dashboard HITL. The private key is read from local `.env` by the demo process and stripped before backend startup. ASGUARD only records the host-reported transaction hash.

## Wallet watch

Wallet watch is secondary, read-only monitoring for registered public NEAR accounts. It stores account, agent, network, label, active state, timestamps, and bounded observed activity in atomic JSON (`ASGUARD_WATCHED_WALLETS_PATH`). The poller checks finalized public blocks over configured HTTPS NEAR RPC, backs off after failures, reports degraded health, and audits observed activity and watcher errors. It does not block chain execution or claim that every event can be attributed to an ASGUARD approval. The dashboard’s **Wallet Watch** tab shows registered accounts, p


**NEAR HACKATHON: Build Beyond Boundaries — AI Security & Defense (`security`), also Agent Economy (`agents`)**

Non-custodial approval and audit control plane for agent value movement on NEAR.

Agents submit the exact unsigned payload, wait for a decision, and verify a short-lived Ed25519 attestation in their trusted host before that host may sign or submit. ASGUARD never accepts keys or seed phrases, never signs or submits on-chain transactions or Intents, never runs a solver, never relays transactions, and never calls Chain Signatures MPC.

Repository: https://github.com/Obahakim/ASGUARD
Problem: Autonomous agents that can move value need a gate that is not the same process that holds the keys.
NEAR’s role: Intents as the primary approval surface; Chain Signatures as a secondary bound approval path; testnet-first demos; public RPC for read-only wallet watch.


Real and working in this repository

- NEAR Intents preflight: decode supported payloads, canonicalize and hash execution fields, evaluate asset/destination/intent policy and time/slippage constraints, check verified fresh USD prices (missing or stale prices require HITL)
- Chain Signatures approval binding: unsigned payload bytes, target network, derivation path, and configured signer contract (foreign-chain targets require HITL by default)
- Host-side Agent SDK: poll HITL, fail closed on timeout/rejection, verify signature, expiry, hash, and bindings, then invoke the callback only after every check passes
- REST and MCP surfaces, role-gated credentials (runtime / admin-operator / auditor), operator dashboard for HITL and policy
- HMAC audit chain and atomic local JSON state (no Postgres)
- Read-only NEAR wallet watch for registered public accounts
- Local demos and tests; demos refuse to run unless `ASGUARD_NEAR_NETWORK=testnet`

What doesn't work;

- No wallet, key custody, live signing, or transaction submission in demos
- No mainnet fund movement, solver, Intents execution engine, or Chain Signatures MPC
- Attestation means the host may proceed only after its own verification; it does not guarantee on-chain success

 Security flow


agent/host → ASGUARD policy + preflight → approved attestation | pending HITL | denied
          → host verifies → host callback may sign/submit


Timeouts deny. Rejected, blocked, malformed, expired, or unverifiable requests never reach the host callback. Attestations bind the exact payload hash, agent, network/domain, and Chain Signatures derivation path and signer contract where applicable.

Use TLS outside local development and distinct high-entropy runtime and admin credentials. Keep the Ed25519 attestation private key and the separate HMAC audit key server-side; distribute only the public attestation key to hosts.

NEAR approval paths

NEAR Intents (primary): Preflight strictly decodes supported payloads, canonicalizes and hashes execution fields, evaluates asset/destination/intent policy and time/slippage constraints, and checks verified fresh USD prices. Missing or stale prices require HITL. This is preflight only: ASGUARD does not run a NEAR VM or claim chain simulation.

Chain Signatures (secondary): Approval binds unsigned payload bytes, target network, derivation path, and configured signer contract. Foreign-chain targets require HITL. Unknown targets are approval-only and require HITL. ASGUARD does not invoke the signer contract or MPC.

Agent SDK (mandatory host pattern)

Use the repository package subpath `asguard/agent-sdk` from a trusted Node.js host. Put **all** host signing and submission work inside the callback.

See [agent-sdk/README.md](agent-sdk/README.md) for NEAR Intent and Chain Signatures examples, required options, and wrong/right patterns.

The helper:

1. Requests approval over REST
2. Polls pending HITL decisions
3. Fails closed on timeout or rejection
4. Verifies attestation signature, expiry, payload hash, and bindings
5. Invokes the callback only after every check passes

Never import the SDK into browser code. Never catch an approval failure and continue to sign.

API and MCP

REST and MCP expose:

- NEAR Intent and Chain Signature approval requests
- Approval status
- Transaction intents
- Policy
- Health and audit diagnostics
- Wallet watch: `asguard_watch_near_wallet`, `asguard_list_watched_wallets`, `asguard_get_wallet_activity`

Roles

| Credential | Can |
| Runtime | Request approvals, register watches |
| Admin / operator | Resolve HITL, manage policy and watches |
| Auditor | Read-only |

Sensitive routes are role-gated. Durable state uses atomic local JSON files under `~/.asguard` (or configured `ASGUARD_*_PATH`). There is no Postgres backend.

Configuration

1. Copy `.env.example` to `.env`.
2. Configure separate runtime and admin/operator API tokens and an independent `ASGUARD_AUDIT_KEY`, each at least 32 bytes. Use the audit key only for audit-chain HMACs; do not provide it to agent hosts.

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Generate the Ed25519 approval key pair using the command in the Configuration section. ASGUARD signs with the private key; the SDK verifies with only the public key.

3. Keep `ASGUARD_NEAR_NETWORK=testnet` for demos. The backend fails early if required credentials are missing or weak. Demos refuse to run on any other network.
4. Demo commands clear inherited `ASGUARD_*` environment values before loading `.env`, so the local file is authoritative.
5. Configure HTTPS NEAR endpoints and `ASGUARD_ALLOWED_ORIGINS` for any non-local deployment.

Run locally

Node.js 20.9 or newer.

```sh
npm install
npm run dev:backend
```

In a second terminal:

```sh
npm run dev:frontend
```

| Service | Default URL |
| --- | --- |
| Backend | http://localhost:8080 |
| Dashboard | http://localhost:3000 |

Authenticate the dashboard with an admin/operator credential.

How to try it (Do X → See Y)

Start both services as above. Use "Approvals" in the dashboard when a request enters HITL. Each command prints backend/network preflight and expected outcome.

1. Do : `npm run demo:near:approve`  
    See : Low-risk unsigned testnet intent preflight → approved status and verified callback, or   HITL if policy or missing/stale price data requires it. Resolve in "Approvals" if needed. No signing.

2. Do: `npm run demo:near:hitl` → approve or deny in "Approvals"  
    See: Pending request ID; only approval reaches the verified host callback.

3.  Do: `npm run demo:near:block`  
     See: Expired intent rejected with its decode/preflight reason.

4.  Do: `npm run demo:agent-guard` → deny the first request, approve the second  
     See: Denial blocks the callback; verified approval reaches it. Still no wallet action.

5. Do (optional): Set `ASGUARD_WATCH_DEMO_ACCOUNT` to a public NEAR testnet account ID, then `npm run demo:watch`  
   See: Registered watch and activity history (an empty history is valid).

The approve/hitl/block/agent-guard/watch demos stop before real signing or transaction submission. Tidepool testnet quotes also stop before settlement unless the host-only `ASGUARD_DEMO_TIDEPOOL_SETTLE=true` flag and matching implicit account key are configured; the tamper demo never signs or submits. No command allows mainnet settlement. Missing/weak credentials, non-testnet configuration, or an unreachable backend fail with actionable instructions.

Custom payloads and multi-scenario runs: [docs/DEMO.md](docs/DEMO.md).

Wallet watch

Secondary, read-only monitoring for registered public NEAR accounts. Stores account, agent, network, label, active state, timestamps, and bounded observed activity in atomic JSON (`ASGUARD_WATCHED_WALLETS_PATH`).

The poller checks finalized public blocks over configured HTTPS NEAR RPC, backs off after failures, reports degraded health, and audits observed activity and watcher errors. It does not block chain execution and does not claim that every observed event maps to an ASGUARD approval.

The dashboard Wallet Watch tab shows registered accounts, poller health, and observed activity. An empty activity list is a valid state.

Operations

Persisted audit, policy, agent profiles, transaction intents, and wallet watches default under `~/.asguard` (or configured `ASGUARD_*_PATH`).

- Back up that directory with a consistent filesystem snapshot and restrictive permissions.
- Keep the audit key separate from backups; restoring the original key is required to verify existing HMAC audit entries.
- Rotate the audit key only with a planned maintenance procedure; archive the old key securely for historical verification.
- Startup verifies the audit chain and rejects tampering.
- Monitor `/api/health`, audit diagnostics, pending HITL age, and wallet-watch health. `/api/health` reflects configured NEAR RPC and watcher health.

Scope

ASGUARD is not a wallet, key custodian, relayer, solver, transaction executor, Intents implementation, Chain Signatures MPC implementation, or NEAR execution simulator.

Attestation means the host may proceed only after its own verification. It does not guarantee transaction success.

Hackathon notes

| Item | Detail |
| --- | --- |
| Primary track | AI Security & Defense (`security`) |
| Secondary track | Agent Economy (`agents`) |
| Project file | [HACKATHON.md](HACKATHON.md) |
| License | [MIT](LICENSE) |
| Baseline | Repository includes pre-window work; treat earlier commits as baseline per official NEAR HACKATHON rules. In-window focus: NEAR-native approval paths, host SDK pattern, demos, and operator workflow. |

oller health, and observed activity; an empty activity list is a valid state.

## Operations

Persisted audit, policy, agent profiles, transaction intents, and wallet watches default under `~/.asguard` (or configured `ASGUARD_*_PATH`). Back up the directory with a consistent filesystem snapshot and restrictive permissions. Keep the audit key separate from backups; restoring the original key is required to verify existing HMAC audit entries. Rotate the audit key only with a planned maintenance procedure and archive the old key securely for historical verification. Startup verifies the audit chain and rejects tampering. Monitor `/api/health`, audit diagnostics, pending HITL age, and wallet-watch health. `/api/health` reflects configured NEAR RPC and watcher health.

## Scope

ASGUARD is not a wallet, key custodian, relayer, solver, transaction executor, Intents implementation, Chain Signatures MPC implementation, or NEAR execution simulator. Attestation means the host may proceed only after its own verification; it does not guarantee transaction success.
