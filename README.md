# ASGUARD

**A non-custodial approval and audit control plane for AI agents moving value on NEAR.**

ASGUARD evaluates an agent's exact unsigned payload, applies policy, and issues a short-lived approval attestation. The trusted agent host verifies that attestation before its own signer can act.

[Watch the ASGUARD demo on X](https://x.com/HakimOba/status/2119490577754439728?a=gj9AznVaCZBLqsCMN1E&s=20)

## What it does

- Preflights supported NEAR Intents and evaluates policy, allowlists, risk, and price freshness.
- Supports approve, human-in-the-loop (HITL), and deny decisions.
- Binds signed attestations to the exact payload and relevant network/signer details.
- Provides a host-side Agent SDK that fails closed if approval or verification fails.
- Includes an operator dashboard, audit records, agent verification, and read-only wallet monitoring.

ASGUARD does not custody keys, sign or broadcast transactions, execute swaps, run a solver, or operate Chain Signatures MPC. Signing keys remain in the trusted agent host.

## What was built for the hackathon

ASGUARD began as a general agent-security project. After the hackathon was announced, we adapted it for NEAR, building the NEAR Intents approval path and NEAR integrations for this submission. The result brings the original security concept into a concrete, verifiable ecosystem workflow.

## Quick start

Requirements: Node.js 20.9 or newer.

```sh
npm install
npm run setup
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and sign in with `.asguard/dashboard-token.txt`. The backend runs at `http://localhost:8080`. Pending HITL requests appear in the approval queue on the dashboard's **Operations** view.

## Try a demo

With the app running:

| Command | Result |
| --- | --- |
| `npm run demo:near:approve` | Preflight, approval, and host-side attestation verification. |
| `npm run demo:near:hitl` | Waits for an operator decision in Operations. |
| `npm run demo:near:block` | Demonstrates fail-closed rejection of an expired intent. |
| `npm run demo:near:tidepool:approve` | Tidepool testnet quote and approval; no settlement by default. |
| `npm run demo:near:tidepool:tamper` | Demonstrates rejection if the approved payload is changed. |
| `npm run demo:watch` | Registers and inspects public wallet activity. |

Approval demos do not sign or move value. Tidepool is a community testnet service and may be unavailable; this does not prevent running the local approval demos.

## Automated judge suite

The CI-style suite uses isolated `.env.ci` and `.asguard-ci/` files. In two terminals:

```sh
# Terminal 1
npm run ci:bootstrap
node --env-file=.env.ci --import tsx scripts/start-backend.ts
```

```sh
# Terminal 2
npm run ci:judge-demos
```

The runner automatically handles its HITL requests and writes redacted logs to `asguard-ci-logs/`. GitHub Actions runs this suite on pushes to `main`; its workflow can also be manually dispatched for an optional testnet settlement. See [docs/DEMO.md](docs/DEMO.md) for all demo modes, platform-specific instructions, and opt-in testnet flows.

## Agent host integration

Use `npm run connect` to configure the runtime token and public attestation key. In a trusted Node.js host, register the agent with `connectAgent` and wrap every value-moving callback with `withAsguardApproval`. Keep signing keys in the host, never in ASGUARD or browser code. See [agent-sdk/README.md](agent-sdk/README.md).

## Safety and configuration

- Denials, timeouts, invalid attestations, and changed payloads fail closed.
- Intents preflight does not guarantee full NEAR VM simulation. External quote and settlement services operate outside ASGUARD.
- Tidepool is an unaffiliated testnet sandbox, not a production route. Mainnet uses official 1Click.
- Wallet watch is public and read-only; it does not block chain execution or guarantee attribution.
- Optional NEAR AI is annotate-only and cannot change allow, HITL, or deny decisions.
- Local durable state uses atomic JSON files; Postgres is not required.

Use `npm run setup` as the primary configuration path. See [.env.example](.env.example) for settings. Keep `.env`, `.asguard/`, and private keys out of version control; use HTTPS and distinct high-entropy credentials outside local development.

For detailed demos and operations, see [docs/DEMO.md](docs/DEMO.md). For host SDK usage, see [agent-sdk/README.md](agent-sdk/README.md).
