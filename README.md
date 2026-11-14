# ASGUARD

**A non-custodial approval and audit control plane for AI agents that move value on NEAR.**

ASGUARD evaluates an agent's exact unsigned payload, applies policy, and issues a short-lived approval attestation. The trusted agent host verifies that attestation before its own signer can act.

**Tracks:** AI Security & Defense (primary) · Agent Economy (secondary) · **License:** [MIT](LICENSE)

**Demo video:** [Watch the ASGUARD demo on X](https://x.com/HakimOba/status/2119490577754439728) · ASGUARD runs locally (see Quick start)

## Vision

ASGUARD is meant to be chain-agnostic: one approval and audit layer that sits in front of an agent's signer, whatever chain the agent acts on. NEAR is the foundation for that goal. Building on NEAR Intents and Chain Signatures gives ASGUARD a path to many chains without building per-chain infrastructure.

**Today, NEAR is the integrated and demonstrated chain.** Other chains are a design goal, not something this submission claims to support.

## What was built for the hackathon

ASGUARD is designed as a chain-agnostic approval layer for agents that move value. After the NEAR Hackathon was announced (19 Oct 2026), it was made NEAR-native, because NEAR Intents and Chain Signatures already provide the cross-chain layer ASGUARD would otherwise have to build itself. The following was built for this submission:

- NEAR Intents preflight, with policy, allowlist, risk, and price-freshness checks.
- Ed25519-signed, short-lived approval attestations bound to the exact unsigned payload.
- A host-side Agent SDK that fails closed unless the attestation and payload binding verify.
- Binding of Chain Signatures requests to their unsigned payload and derivation details.
- Verification of host-reported NEAR testnet transfers against NEAR RPC.
- Demos and an automated judge suite that run against the NEAR Intents flow, including Tidepool testnet quotes.

This brings the original agent-security concept into a concrete, verifiable NEAR workflow: give an AI agent the ability to move money without giving it unchecked control of the keys.

### Baseline vs. hackathon work

- **Announcement:** 19 Oct 2026. Commits up to `67a0ac8` (12 Oct 2026) are the baseline: an earlier ASGUARD prototype (started Jul 2026) built around a different agent runtime, with no NEAR integration code.
- **The NEAR integration was written after the announcement:** NEAR Intents preflight, NEAR RPC, wallet watch, the host SDK, the setup and connect CLIs, the demos, and the judge suite.
- **Git tags mark the boundary:** `pre-hackathon` is the baseline and `hackathon-submission` is this submission. [Compare them](https://github.com/Obahakim/ASGUARD/compare/pre-hackathon...hackathon-submission) to see everything built in the window.

## The problem

An agent with access to a wallet can be manipulated by prompt injection, run away in a loop, or send funds to a look-alike address. Giving the agent an unrestricted key offers no approval boundary; moving funds into a custody vault changes who controls them.

ASGUARD keeps the signing key with the trusted agent host and provides a separate decision and audit layer. Approval is bound to the exact payload the host submitted; changing that payload invalidates the approval.

## What ASGUARD does

- Preflights supported unsigned NEAR Intents payloads and evaluates policy, allowlists, risk, and price freshness.
- Supports three decisions: approve, human-in-the-loop (HITL), and deny.
- Issues short-lived, Ed25519-signed approval attestations for approved payloads.
- Provides a host-side Agent SDK that handles HITL polling and fails closed unless the attestation and exact payload binding verify.
- Binds Chain Signatures requests to their unsigned payload and derivation details; it does not operate the signer or MPC.
- Records host-reported transfers and verifies them against NEAR RPC (submission reporting is currently enabled for NEAR testnet only).
- Offers read-only wallet activity monitoring, an operator dashboard with audit records, setup/connect CLIs, and optional NEAR AI annotation that cannot change policy decisions.

### Approval flow

```text
Trusted host submits exact unsigned payload
  -> ASGUARD preflight and policy evaluation
  -> approve with signed attestation, request HITL, or deny
  -> host verifies signature, expiry, and exact payload binding
  -> only then may the host's own signer callback act
```

Denials, timeouts, invalid attestations, and payload changes fail closed. Keep signing logic and keys in the trusted host, not in ASGUARD or browser code.

## Quick start

Requirements: Node.js 20.9 or newer.

```sh
npm install
npm run setup -- --yes
npm run dev
```

`--yes` fills in safe testnet defaults without prompting, so it also works in scripts and CI. Plain `npm run setup` is the interactive wizard and needs a real terminal; use `npm run setup -- --advanced` for endpoint, AI, webhook, and demo settings. Leave `npm run dev` running and open a second terminal for the demos below.

`npm run dev` starts the backend at `http://localhost:8080` and the dashboard at `http://localhost:3000`. If you chose to start the stack from the setup wizard, it is already running. On Windows, setup opens a PowerShell window with live output and saves the same output to `.asguard/dev.log`.

Open [http://localhost:3000](http://localhost:3000) and sign in with the token in `.asguard/dashboard-token.txt`. Pending HITL requests appear in the approval queue on the dashboard's **Operations** view.

## Try a demo

With the stack running, run a command and observe the result:

| Do this | See this |
| --- | --- |
| `npm run demo:near:approve` | NEAR Intent preflight succeeds and the host reaches its verified approval callback. If fresh price data is unreachable, ASGUARD fails closed to HITL instead: approve the pending request in **Operations** to continue. |
| `npm run demo:near:hitl` | A pending request appears in the **Operations** approval queue; approve or deny it to continue the demo. |
| `npm run demo:near:block` | An expired or rejected Intent is blocked; the host callback does not run. |
| `npm run demo:near:tidepool:approve` | A live Tidepool testnet quote is approved without signing or settling by default. |
| `npm run demo:near:tidepool:tamper` | The host rejects a payload changed after approval; no transaction is submitted. |
| `npm run demo:agent-guard` | The denied callback is blocked and the verified callback is allowed. |
| `npm run demo:watch` | Public wallet activity is registered and inspected; monitoring is read-only. |

Approval demos do not sign or move value. Tidepool is a community-operated testnet service. Its quote-based demos need network access and can fail if Tidepool is unavailable; this does not prevent running the local approval demos.

## Automated judge suite (no dashboard interaction)

This suite uses an isolated `.env.ci` and `.asguard-ci/` key directory, leaving your normal `.env` and `.asguard/` configuration untouched. Use two terminals from the repository root.

**Terminal 1: create CI configuration and start the backend**

```sh
npm run ci:bootstrap
node --env-file=.env.ci --import tsx scripts/start-backend.ts
```

**Terminal 2: run the scenarios**

```sh
npm run ci:judge-demos
```

**Expected result:** `block`, `hitl-deny`, and `hitl-allow` PASS with no network access beyond localhost. The two Tidepool scenarios (`tidepool-tamper`, `tidepool-approve`) PASS only when the machine can reach `https://www.usetidepool.tech`; on a network that blocks it, those two report FAIL and the local scenarios are unaffected.

The runner automatically answers its own matching HITL requests. It prints a per-scenario `PASS` / `FAIL` / `SKIP` result and a summary; redacted scenario logs are written to `asguard-ci-logs/`. The default suite checks block, HITL deny/allow, Tidepool tamper, and approval-only quote behavior. Settlement and faucet requests are off by default.

GitHub Actions runs the default suite on pushes to `main`. A manual `workflow_dispatch` can opt in to the capped testnet settlement scenario. The workflow generates isolated credentials and uploads redacted logs as the `asguard-judge-demo-logs` artifact.

### Optional testnet settlement (explicit opt-in)

Settlement is not needed for the judge path above. To enable it for the local automated suite, generate an ephemeral Tidepool testnet wallet:

```sh
npm run ci:bootstrap:onchain
```

Restart the backend with the newly generated `.env.ci`, then run the suite with the opt-in flag.

POSIX shell:

```sh
ASGUARD_JUDGE_ONCHAIN=true npm run ci:judge-demos
```

PowerShell:

```powershell
$env:ASGUARD_JUDGE_ONCHAIN = 'true'
npm run ci:judge-demos
```

This enables the capped Tidepool testnet settlement scenario and faucet request. It is not a mainnet flow. Never use a mainnet key.

For all demo modes, platform-specific notes, and opt-in testnet flows, see [docs/DEMO.md](docs/DEMO.md).

## Agent host integration

Use `npm run connect` to configure the host's runtime token and attestation public key. In the trusted Node.js host, register the agent with `connectAgent` and wrap every value-moving signer or submission callback with `withAsguardApproval`. The callback is reached only after SDK verification. Keep private keys in the host; ASGUARD never receives them. Do not put this SDK or signer code in browser bundles. See [agent-sdk/README.md](agent-sdk/README.md).

## Network scope: what runs where

- **Mainnet-capable by configuration:** policy evaluation, signed attestations, the host SDK, NEAR RPC access, wallet watch, and NEAR Intents defaults all accept `near:mainnet` as well as `near:testnet`, and unit tests cover both. Mainnet uses official 1Click (`https://1click.chaindefuser.com`) with verifier `intents.near`.
- **Testnet only:** every demo script, the automated judge suite, Tidepool quotes and settlement, the NEAR transfer submission demo, and host-reported transaction verification. The demo scripts refuse non-testnet configuration, and no mainnet flow is exercised by these demos.

## Limits and safety boundaries

- ASGUARD never takes custody of agent keys or seed phrases, signs or broadcasts transactions, executes swaps, runs a solver, or runs Chain Signatures MPC.
- Denials, timeouts, invalid attestations, and changed payloads fail closed.
- Intents preflight is not a guarantee of full NEAR VM simulation. External quote, bridge, solver, and settlement services operate outside ASGUARD.
- Tidepool (`https://www.usetidepool.tech`) is an unaffiliated community testnet 1Click-shaped sandbox, not a production route. Mainnet configuration uses official 1Click (`https://1click.chaindefuser.com`) with verifier `intents.near`; testnet Tidepool demos use `verifier.tidepool-sandbox.testnet`.
- Wallet watch is public, read-only monitoring; it does not block chain execution or guarantee attribution. Host-reported transaction verification is supported only for the documented report paths.
- Optional NEAR AI is annotate-only and cannot change allow, HITL, or deny decisions.
- Local durable state uses atomic JSON files; Postgres is not required.

## Built with

TypeScript on Node.js 20.9+; Next.js and React for the dashboard; Express and `ws` for the backend API; `near-api-js`; Tailwind CSS. External services: NEAR RPC (FastNEAR, with failover endpoints), NEAR Intents 1Click (official endpoint on mainnet, the Tidepool community sandbox for testnet demos), and optional NEAR AI. Parts of this codebase were written with AI coding assistance.

## Configuration and further reading

Use `npm run setup` as the primary configuration path. See [.env.example](.env.example) for the full reference and fallback. Keep `.env`, `.asguard/`, and all private keys out of version control. Use HTTPS endpoints and distinct high-entropy runtime and admin credentials outside local development.

For detailed demos and operations, see [docs/DEMO.md](docs/DEMO.md). For host SDK usage, see [agent-sdk/README.md](agent-sdk/README.md).