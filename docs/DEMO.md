# ASGUARD demo guide

These demos are the reference agent-host flow: the host registers an agent, submits an exact unsigned payload, waits for ASGUARD's decision, verifies the short-lived attestation, and only then may reach its own signer callback.

ASGUARD does not hold agent keys, sign transactions, broadcast transactions, execute swaps, or run a solver. Approval demos stop at host-side verification and do not move value. The separate Tidepool settlement and NEAR transfer submission demos can move testnet value only after explicit opt-in; their keys stay in the host process, not in the ASGUARD backend.

For a judge run that needs no dashboard interaction, go to [Automated judge suite](#automated-judge-suite-no-dashboard-interaction).

## What you need

- Node.js 20.9 or newer.
- Dependencies installed with `npm install`.
- A local configuration created with `npm run setup` (recommended), or a manually configured `.env` based on [`.env.example`](../.env.example).
- The backend and dashboard running for interactive demos.

Start the app with:

```sh
npm run dev
```

This starts the backend at `http://localhost:8080` and the dashboard at `http://localhost:3000`. Alternatively, run `npm run dev:backend` and `npm run dev:frontend` in separate terminals. Sign in with the token in `.asguard/dashboard-token.txt`; resolve human-in-the-loop (HITL) requests in the approval queue on the **Operations** view.

The demo scripts check backend credentials and reachability before sending a request. Missing or weak credentials, an unavailable backend, or a non-testnet configuration fail before the demo request. A low-risk request can still be sent to HITL if fresh verified price data or policy allowlists are unavailable; this is intentional fail-closed behavior.

## Core demos: do this, see this

With the stack running, try these commands:

| Do this | See this |
| --- | --- |
| `npm run demo:near:approve` | NEAR Intent preflight completes, the host verifies the approval attestation, and the host callback runs. The callback is a demo callback; it does not sign or submit. |
| `npm run demo:near:hitl` | A request appears in the **Operations** view's approval queue. The host continues only according to the operator's approve/deny decision; denial or timeout does not reach the callback. |
| `npm run demo:near:block` | An expired/rejected unsigned Intent is blocked; the callback does not run. |
| `npm run demo:agent-guard` | The denied callback is blocked and a verified callback is allowed. |
| `npm run demo:near:tidepool:approve` | A live Tidepool testnet quote is bound to an approval; no settlement occurs by default. |
| `npm run demo:near:tidepool:tamper` | The demo obtains approval for payload A, changes it to payload B, and host verification rejects the changed payload. Nothing is signed or submitted. |
| `npm run demo:watch` | A public wallet is registered and its activity can be inspected in Operations; this is read-only monitoring. |

The approval demos use the Agent SDK's host-side verification path. Do not move signing logic or keys into the ASGUARD backend or browser.

## Tidepool Intents demo (testnet only)

[Tidepool](https://www.usetidepool.tech) is a community-built, 1Click-compatible testnet sandbox; it is not affiliated with NEAR, Defuse, or official 1Click. Test tokens have no value. ASGUARD evaluates and verifies the approved payload; Tidepool operates its own quote, maker/solver, bridge relayer, and settlement services.

On testnet, opting into the Tidepool demo uses `https://www.usetidepool.tech` and verifier `verifier.tidepool-sandbox.testnet`. Approval-only Tidepool demos require this URL/verifier pair. Mainnet uses official 1Click at `https://1click.chaindefuser.com` with verifier `intents.near`; ASGUARD does not force Tidepool on mainnet.

With the backend running and the dashboard ready to resolve HITL, run:

```sh
npm run demo:near:tidepool:approve
npm run demo:near:tidepool:tamper
```

Both demos request a live Tidepool quote, bind its exact `swap_transfer` payload and quote signature into an ASGUARD approval, and register the public demo account with `connectAgent`. The approval command is approval-only by default: it does not sign, submit, or move tokens. The tamper demo must report `attestation/payload binding rejected change after approval`; it never submits, even if settlement is enabled.

### Optional capped Tidepool testnet settlement

This is not required for the judge path. To explicitly opt in, use a NEAR implicit testnet account and configure these host-only values in `.env`:

```dotenv
ASGUARD_DEMO_TIDEPOOL_SETTLE=true
ASGUARD_DEMO_TIDEPOOL_ACCOUNT_ID=<64-character lowercase hex public-key account ID>
ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY=ed25519:<base58 NEAR secret key>
```

The account ID must be the public key in 64-character lowercase hex and match the private key. The demo approval is capped at $2 and requests a 0.1 USDC swap. To opt into requesting Tidepool's limited `mode: intents` USDC faucet before settlement, also set:

```dotenv
ASGUARD_DEMO_TIDEPOOL_FAUCET=true
```

Otherwise, fund the account's Intents balance through Tidepool first. Then run `npm run demo:near:tidepool:approve`. The host waits for approval, verifies the attestation again, signs Tidepool's generated raw Ed25519 payload locally, submits it to Tidepool, and polls for final status. The backend strips `ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY` at startup. Never use a mainnet key; this demo refuses mainnet and non-Tidepool endpoints.

Tidepool availability, quote quality, faucet rate limits, and settlement are external dependencies. If Tidepool is unavailable, the demo reports an error; local ASGUARD approval demos can still run.

## Optional NEAR testnet transfer submission

The `npm run demo:near:approve:submit` command is separate from the approval-only demos and can submit a real, small NEAR testnet transfer. It is disabled unless `ASGUARD_DEMO_SUBMIT=true`. It requires `ASGUARD_DEMO_NEAR_ACCOUNT_ID`, `ASGUARD_DEMO_NEAR_PRIVATE_KEY`, and `ASGUARD_DEMO_NEAR_RECIPIENT`; `ASGUARD_DEMO_NEAR_AMOUNT` is optional and defaults to `0.001` NEAR. Use only a funded testnet demo account, a public testnet recipient, and an amount no greater than `0.01` NEAR. The host verifies approval before signing; ASGUARD only records the reported transaction hash.

The backend removes this demo's private key at startup. A pending transfer requires an operator decision in the approval queue on the **Operations** view; rejection or timeout does not reach the host signing callback. After signing and submission, ASGUARD verifies the reported transaction against NEAR RPC. Never use a mainnet key or seed phrase.

## Automated judge suite (no dashboard interaction)

The suite creates an isolated `.env.ci` and `.asguard-ci/` key directory, so it leaves the normal `.env` and `.asguard/` configuration untouched. From the repository root, use two terminals.

**Terminal 1 - generate the test configuration and start the backend:**

```sh
npm run ci:bootstrap
node --env-file=.env.ci --import tsx scripts/start-backend.ts
```

**Terminal 2 - run the scenarios:**

```sh
npm run ci:judge-demos
```

The runner automatically handles matching HITL decisions; no dashboard interaction is needed. It prints each scenario's `PASS`, `FAIL`, or `SKIP` result and a final summary. Redacted per-scenario logs and `summary.log` are written to `asguard-ci-logs/`. The default scenarios check expired-intent blocking, HITL deny and allow, Tidepool tamper rejection, and Tidepool approval without settlement. On-chain settlement is skipped unless explicitly requested.

GitHub Actions runs the default suite on pushes to `main`. The manual `workflow_dispatch` input can opt into the capped testnet settlement scenario. The workflow generates isolated credentials and uploads redacted logs as the `asguard-judge-demo-logs` artifact.

### Optional on-chain CI scenario

For a local opt-in run, generate a testnet configuration with an ephemeral Tidepool wallet:

```sh
npm run ci:bootstrap:onchain
```

Restart the backend with the newly generated `.env.ci`. Set the opt-in flag in the terminal where you run the suite:

```sh
ASGUARD_JUDGE_ONCHAIN=true npm run ci:judge-demos
```

In PowerShell, set `$env:ASGUARD_JUDGE_ONCHAIN = 'true'` first, then run `npm run ci:judge-demos`. This explicitly enables the capped testnet settlement and faucet path; it is not a mainnet flow. Never use a mainnet key.

## Multi-scenario suite

Run several built-in scenarios sequentially:

```sh
npm run demo:suite -- --scenario approve --scenario hitl --scenario block
```

Or run a scenario file:

```sh
npm run demo:suite -- --file scripts/demo-scenarios.example.json
```

A scenario file has a top-level `scenarios` array. Each entry supports:

- `name`: readable label.
- `mode`: `approve`, `hitl`, or `block`.
- `riskLevel`: optional `low`, `medium`, `high`, or `critical`; defaults to `high` for HITL and `low` otherwise.
- `agentId`: optional per-scenario agent ID.
- `intent`: optional NEAR Intent object. Omitted fields use local demo defaults. A `block` scenario intentionally replaces its deadline with a fixed expired date.

Scenarios run in order. An HITL scenario waits up to three minutes for a dashboard decision. A denied or timed-out request does not invoke the host callback. Each run uses fresh idempotency keys so an earlier local JSON record cannot make a repeat look like a new approval.

`mode: "block"` submits an expired unsigned intent and expects ASGUARD to reject it during decoding. `mode: "approve"` verifies the approval attestation and calls a no-op host callback. `mode: "hitl"` requests a dashboard decision and reaches the callback only if an operator approves. These modes do not sign or submit transactions.

## Scope and limits

- These demos exercise approval and host-side verification; they are not a guarantee of full NEAR VM simulation.
- Approval attestations authorize only the exact bound payload and expire. A changed payload, rejection, timeout, or failed verification must not reach the signing callback.
- Wallet watch is public, read-only monitoring. It does not block chain execution or guarantee attribution.
- Tidepool and NEAR RPC availability are external dependencies; Tidepool is not an ASGUARD production service.
- Only the explicitly enabled Tidepool settlement and NEAR transfer submission demos can move testnet value. Never use mainnet credentials.

For the product overview and local dashboard quick start, see the [main README](../README.md). For host-side SDK integration, see [`agent-sdk/README.md`](../agent-sdk/README.md).

## Integration contract

Production agent hosts should use the same host-side functions exercised by the approval demos: call `connectAgent` during host startup, then wrap every value-moving operation in `withAsguardApproval` from the [`asguard/agent-sdk` package](../agent-sdk/README.md). Keep the signing key in that trusted host and put every signing or submission step inside the verified callback. For supported NEAR transfers, use `reportSubmission` after submission so ASGUARD can verify the transaction against RPC. The SDK guide documents required bindings, failure behavior, and reporting details.
