# ASGUARD

ASGUARD is a non-custodial approval and audit control plane for agent value movement. It evaluates exact unsigned payloads and issues short-lived attestations that a trusted agent host verifies before its own signer can act. ASGUARD holds no agent wallet keys, runs no solver, and does not use MPC.

## Tracks and license

ASGUARD's primary hackathon track is **security**; **agents** is the secondary track. The project is released under the [MIT License](LICENSE).

## Features

- NEAR Intents preflight for supported unsigned payloads, policy checks, and price freshness.
- Tidepool community testnet 1Click-shaped quote, approval, tamper, and optional settlement demos.
- Chain Signatures payload and derivation binding.
- Agent SDK with HITL polling and fail-closed attestation verification.
- Host-reported transfer records with RPC verification; ASGUARD never signs or broadcasts.
- Read-only wallet watch, optional NEAR AI annotate-only enrichment, setup/connect CLIs, and operator dashboard.

## What ASGUARD does not do

ASGUARD does not custody agent keys, sign or broadcast transactions, execute swaps, operate a solver, run Chain Signatures MPC, or guarantee complete chain simulation. Tidepool is a community testnet sandbox, not an ASGUARD service or production route.

## Security flow

`host submits exact unsigned payload → ASGUARD preflight/policy → approved attestation or HITL/deny → host verifies exact binding → host-owned signer callback may act`

Timeouts, denials, and invalid or changed payloads fail closed. The backend keeps the attestation private key and audit HMAC key; trusted hosts need the attestation public key and runtime token. Never put host signing logic on the ASGUARD server.

## Quick start

1. Install Node.js 20.9 or newer.
2. Install dependencies: `npm install`.
3. Run `npm run setup`. The wizard writes local configuration and keys; on testnet it can optionally create a Tidepool demo key and enable faucet/settlement. At the end, interactive setup can start the stack and optionally open the browser.
4. If you skipped startup, run `npm run dev` (backend on port 8080 and dashboard on port 3000).
5. Open [http://localhost:3000](http://localhost:3000) and sign in with the dashboard token at `.asguard/dashboard-token.txt`.

The setup wizard's safe `--yes` mode never creates a demo wallet, enables settlement, starts the server, or opens a browser.

## Try the demos

Run the stack first. Approve or deny HITL requests in the dashboard's Approvals view.

| Do this | See this |
| --- | --- |
| `npm run setup` | Local `.env`, server attestation keys, and dashboard token; optional Tidepool testnet key/settlement and optional stack/browser start. |
| `npm run dev` | Backend at `http://localhost:8080` and dashboard at `http://localhost:3000`. |
| `npm run demo:near:approve` | NEAR Intent preflight and the host's verified approval callback. |
| `npm run demo:near:hitl` | A pending request to resolve in the dashboard. |
| `npm run demo:near:block` | A rejected/expired Intent and fail-closed callback. |
| `npm run demo:near:tidepool:approve` | A real Tidepool testnet quote and ASGUARD approval, without settlement by default. |
| Set `ASGUARD_DEMO_TIDEPOOL_SETTLE=true`, then run `npm run demo:near:tidepool:approve` | Optional capped testnet settlement using the local host-only demo key; `ASGUARD_DEMO_TIDEPOOL_FAUCET=true` opts into Tidepool faucet requests. Setup can create this implicit account/keypair. Never use a mainnet key. |
| `npm run demo:near:tidepool:tamper` | Post-attestation payload modification rejected by host verification; it never moves value. |
| `npm run demo:near:approve:submit` | Opt-in testnet NEAR transfer (maximum 0.01 NEAR) and a host-reported transaction for backend verification. |
| `npm run demo:agent-guard` | A denied callback is blocked and a verified callback is allowed. |
| `npm run demo:watch` | Register and inspect public wallet activity. |
| `npm run connect` | Configure an agent host with runtime credentials and the attestation public key. |

Tidepool (`https://www.usetidepool.tech`) is a community free testnet 1Click-shaped API, unaffiliated with NEAR, Defuse, or official 1Click. It supplies quotes/status and may supply faucet support; it does not run ASGUARD's policy or solver. Production mainnet configuration must use official 1Click at `https://1click.chaindefuser.com` with verifier `intents.near`. ASGUARD never forces Tidepool on mainnet.

## Agent host integration

Use `npm run connect` to configure the host's runtime token and attestation public key. Register the agent with `connectAgent`, then wrap every value-moving callback with `withAsguardApproval` from `asguard/agent-sdk`. Keep private signing keys in the trusted host, never in ASGUARD or browser code. The SDK verifies the attestation and exact payload before invoking the callback. See [agent-sdk/README.md](agent-sdk/README.md).

## Configuration

The setup wizard is the primary path. See [.env.example](.env.example) for the full configuration reference and fallback. Testnet defaults use Tidepool at `https://www.usetidepool.tech` with verifier `verifier.tidepool-sandbox.testnet`. Mainnet must explicitly use official 1Click and `intents.near`. Tidepool demo settlement is testnet-only, opt-in, and uses a private key held by the demo host process; the backend strips `ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY` at startup.

Keep `.env`, `.asguard/`, and all private keys out of version control. Use HTTPS endpoints and distinct high-entropy runtime/admin credentials outside local development. Optional NEAR AI is annotate-only: it cannot change allow, HITL, or deny decisions.

## Operations and scope

The backend stores durable state in local atomic JSON files; it does not require Postgres. The host may report a completed transaction, and existing reporting paths verify the approved payload and chain record. Wallet watch is public, read-only monitoring and does not block chain execution or guarantee attribution. Intents preflight is not a NEAR VM simulation. ASGUARD is the approval/audit layer; Tidepool or another external service operates its own quote/settlement infrastructure.

For demo details, see [docs/DEMO.md](docs/DEMO.md). For host SDK usage, see [agent-sdk/README.md](agent-sdk/README.md).
