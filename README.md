# ASGUARD

**A non-custodial approval and audit control plane for AI agents that move value on NEAR.**

ASGUARD checks an agent's exact unsigned payload, evaluates policy, and issues a short-lived attestation. The trusted agent host verifies the attestation before its own signer can act.

**Primary track:** security · **Secondary track:** agents · **License:** [MIT](LICENSE)

## The problem

An agent with access to a wallet can be manipulated by prompt injection, run away in a loop, or send funds to a look-alike address. Giving the agent an unrestricted key offers no approval boundary; moving funds into a custody vault changes who controls them.

ASGUARD keeps the signing key with the trusted agent host and provides a separate decision and audit layer. Approval is bound to the exact payload the host submitted; changing that payload invalidates the approval.

## What ASGUARD does

- Preflights supported unsigned NEAR Intents payloads and evaluates policy, allowlists, risk, and price freshness.
- Issues short-lived, Ed25519-signed approval attestations for approved payloads.
- Provides a host-side Agent SDK that handles human-in-the-loop (HITL) polling and fails closed unless the attestation and exact payload binding verify.
- Binds Chain Signatures requests to their unsigned payload and derivation details; it does not operate the signer or MPC.
- Records host-reported transfers and verifies supported reports against NEAR RPC.
- Offers read-only wallet activity monitoring, an operator dashboard, setup/connect CLIs, and optional NEAR AI annotation that cannot change policy decisions.

### Approval flow

```text
Trusted host submits exact unsigned payload
  -> ASGUARD preflight and policy evaluation
  -> approve with signed attestation, request HITL, or deny
  -> host verifies signature, expiry, and exact payload binding
  -> only then may the host's own signer callback act
```

Denials, timeouts, invalid attestations, and payload changes fail closed. Keep signing logic and keys in the trusted host, not in ASGUARD or browser code.

## Judge path: run it and see the result

### Start the local dashboard and backend

1. Install Node.js 20.9 or newer, then install dependencies:

   ```sh
   npm install
   ```

2. Run the setup wizard:

   ```sh
   npm run setup
   ```

   The quick setup uses safe local defaults; creating a Tidepool demo wallet is optional. For advanced endpoint, AI, webhook, and demo settings, use `npm run setup -- --advanced`.

3. Start the app:

   ```sh
   npm run dev
   ```

   This runs the backend at `http://localhost:8080` and dashboard at `http://localhost:3000`. If you chose to start the stack from the setup wizard, it is already running. On Windows, setup opens a PowerShell window with live output and saves the same output to `.asguard/dev.log`.

4. Open [http://localhost:3000](http://localhost:3000) and sign in with the token in `.asguard/dashboard-token.txt`. Resolve pending requests in the **Operations** view's approval queue.

### Run a demo

With the stack running, try a command and observe the corresponding result:

| Do this | See this |
| --- | --- |
| `npm run demo:near:approve` | NEAR Intent preflight succeeds and the host reaches its verified approval callback. |
| `npm run demo:near:hitl` | A pending request appears in the **Operations** view's approval queue; approve or deny it to continue the demo. |
| `npm run demo:near:block` | An expired/rejected Intent is blocked; the host callback does not run. |
| `npm run demo:near:tidepool:approve` | A live Tidepool testnet quote is approved without signing or settling by default. |
| `npm run demo:near:tidepool:tamper` | The host rejects a payload changed after approval; no transaction is submitted. |
| `npm run demo:agent-guard` | The denied callback is blocked and the verified callback is allowed. |
| `npm run demo:watch` | Public wallet activity is registered and inspected; monitoring is read-only. |

Tidepool is a community-operated testnet service. Its quote-based demos need network access and can fail if Tidepool is unavailable; this does not prevent running the local approval demos.

### Run the automated judge suite (no dashboard interaction)

This suite uses an isolated `.env.ci` and `.asguard-ci/` key directory, leaving normal `.env` and `.asguard/` configuration untouched. Use two terminals from the repository root.

**Terminal 1 - create CI configuration and start the backend:**

```sh
npm run ci:bootstrap
node --env-file=.env.ci --import tsx scripts/start-backend.ts
```

**Terminal 2 - run the scenarios:**

```sh
npm run ci:judge-demos
```

The runner automatically answers its own matching HITL requests. It prints a per-scenario `PASS`/`FAIL`/`SKIP` result and a summary; redacted scenario logs are written to `asguard-ci-logs/`. The default suite checks block, HITL deny/allow, Tidepool tamper, and approval-only quote behavior. Settlement and faucet requests are off by default.

GitHub Actions runs the default suite on pushes to `main`. A manual `workflow_dispatch` can opt in to the capped testnet settlement scenario. The workflow generates isolated credentials and uploads redacted logs as the `asguard-judge-demo-logs` artifact.

### Optional testnet settlement (explicit opt-in)

Settlement is not needed for the judge path above. For the local automated suite, explicitly generate an ephemeral Tidepool testnet wallet:

```sh
npm run ci:bootstrap:onchain
```

Restart the backend using the newly generated `.env.ci`. Set the opt-in flag in the second terminal, then run the suite:

```sh
ASGUARD_JUDGE_ONCHAIN=true npm run ci:judge-demos
```

In PowerShell, use `$env:ASGUARD_JUDGE_ONCHAIN = 'true'` before `npm run ci:judge-demos`. This opt-in enables the capped Tidepool testnet settlement scenario and faucet request; it is not a mainnet flow. Never use a mainnet key.

## Agent host integration

Use `npm run connect` to configure the host's runtime token and attestation public key. In the trusted Node.js host, register the agent with `connectAgent` and wrap every value-moving signer/submission callback with `withAsguardApproval` from [`agent-sdk/README.md`](agent-sdk/README.md). The callback is reached only after SDK verification. Keep private keys in the host; ASGUARD never receives them. Do not put this SDK or signer code in browser bundles.

## Limits and safety boundaries

- ASGUARD never takes custody of agent keys or seed phrases, signs or broadcasts transactions, executes swaps, runs a solver, or runs Chain Signatures MPC.
- Intents preflight is not a guarantee of full NEAR VM simulation. External quote, bridge, solver, and settlement services operate outside ASGUARD.
- Tidepool (`https://www.usetidepool.tech`) is an unaffiliated community testnet 1Click-shaped sandbox, not a production route. Mainnet configuration uses official 1Click (`https://1click.chaindefuser.com`) with verifier `intents.near`; testnet Tidepool demos use `verifier.tidepool-sandbox.testnet`.
- Wallet watch is public, read-only monitoring; it does not block chain execution or guarantee attribution. Host-reported transaction verification is supported only for the documented report paths.
- Optional NEAR AI is annotate-only and cannot change allow, HITL, or deny decisions.
- Local durable state uses atomic JSON files; Postgres is not required.

## Configuration and further reading

The setup wizard is the primary configuration path. See [`.env.example`](.env.example) for the full reference and fallback. Keep `.env`, `.asguard/`, and all private keys out of version control. Use HTTPS endpoints and distinct high-entropy runtime/admin credentials outside local development.

For detailed demos, see [`docs/DEMO.md`](docs/DEMO.md). For host SDK usage, see [`agent-sdk/README.md`](agent-sdk/README.md).
