# ASGUARD Solana devnet and MCP

ASGUARD's policy and anomaly engine remain chain-neutral. The active adapter in this build is Solana devnet; it owns RPC health checks, signed-transaction simulation, and guarded submission. Chain status appears in `GET /api/health` and in the dashboard.

The devnet RPC defaults to `https://api.devnet.solana.com`. Set `ASGUARD_SOLANA_CLUSTER=devnet` to make the intended network explicit. A custom HTTPS RPC can be used with `ASGUARD_SOLANA_RPC_URL` and `ASGUARD_SOLANA_ALLOW_CUSTOM_RPC=true`; every health, simulation, and send operation verifies the official devnet genesis hash first. The current public RPC is rate limited and intended for development, not production service traffic. Use a dedicated provider for a production deployment and implement a separately reviewed production cluster adapter before enabling mainnet.

## MCP client

The backend serves a stateless Streamable HTTP MCP endpoint at `POST http://localhost:8080/mcp`. Configure the client with that URL and a bearer token from `ASGUARD_API_CREDENTIALS`. Use a dedicated credential with the `runtime` role for agent tools; use `operator` or `admin` for policy reads, approvals, and dashboard access. Never put an admin token in a bot configuration.

Available tools:

- `asguard_get_status`: runtime and chain health.
- `asguard_get_policy`: active policy; requires admin, operator, or auditor role.
- `asguard_report_activity`: submit activity to the existing anomaly engine, audit chain, event stream, and human approval handler.
- `asguard_guarded_solana_send`: create an idempotent transaction intent, evaluate and audit the activity, simulate the signed transaction on verified devnet, wait for an authenticated human approval, and only then submit it.
- `asguard_get_transaction_status`: query an intent by ID.
- `asguard_report_security_violation`: report an incident and wait for the authenticated human decision. It reports the decision to a cooperative client; it cannot terminate an independent process.

## Test without a trading bot

The repo includes a free paper trader. It sends a synthetic market observation and a simulated compromise alert to MCP; it does not need a wallet, API from an exchange, or devnet SOL, and it never creates or submits a transaction.

1. Start the backend and dashboard with `pnpm dev`.
2. Ensure `.env` contains a valid `ASGUARD_API_CREDENTIALS` entry with the `runtime` role and token of at least 32 bytes, plus an `ASGUARD_AUDIT_KEY` of at least 32 bytes.
3. Run `pnpm demo:trader`.
4. Open the dashboard and connect with an `operator` or `admin` API token. Approve or deny the pending simulated compromise alert. The command prints the resulting decision.

Run `pnpm demo:trader -- --activity-only` to send only the synthetic activity event. To test an actual devnet send later, use a separate disposable devnet wallet funded with faucet SOL; the guarded MCP tool always pauses for human approval and submits only after approval.

## Claude clients

Claude Code can connect directly to the local Streamable HTTP endpoint. In PowerShell, replace the placeholder with the dedicated runtime token from your local environment:

```powershell
claude mcp add --transport http --scope user asguard http://localhost:8080/mcp --header "Authorization: Bearer <runtime-token>"
claude mcp get asguard
```

This adds a user-scoped server to Claude Code. Do not put a token in the repository's `.mcp.json` or share the command with its literal token. The runtime token can report and request guarded sends; use the dashboard's separate operator token for human decisions.

Claude Desktop's remote custom connectors are added from **Settings → Connectors**. They need a Claude-accessible remote URL; the local `localhost` endpoint is not reachable from Claude's hosted connector service. For a local-only desktop connection, this repo would need a separate stdio MCP adapter, or ASGUARD would need to be deployed behind a trusted HTTPS endpoint. Remote custom connectors are available on eligible paid Claude plans; Claude Code supports adding an HTTP MCP endpoint from its CLI.

The transaction tool requires an `idempotency_key`, agent and wallet identifiers, action, risk level, caller-declared USD amount, and a base64 signed transaction. The declared USD amount is not independently decoded or valued from transaction instructions. Therefore every transaction currently requires human approval, including quiet anomaly results; simulation failures are blocked. A future automatic path needs a reviewed instruction decoder and trusted valuation source before it can safely apply the trade budget without a human.

Transaction intents and idempotency keys are stored atomically at `~/.astrid/transaction_intents.json` by default. Set `ASGUARD_TRANSACTION_INTENTS_PATH` to choose another local path. Keep this ledger on persistent storage; a malformed ledger prevents startup instead of silently resetting replay protection.

Transactions submitted through the guarded tool cannot be recalled after Solana accepts them. For a compromised bot to be unable to bypass ASGUARD, restrict its network egress so it cannot reach other Solana RPC endpoints and keep signing authority behind a controlled signer. MCP policy alone cannot stop a process that can broadcast directly with its own RPC credentials.

## Dashboard

Open the existing dashboard and enter an ASGUARD API credential with `operator` or `admin` role. The credential stays in that browser tab's session storage. The page then connects to the ticket-authenticated WebSocket, loads chain status and pending approvals, streams real agent/anomaly events, displays transaction intents, and updates policy through the authenticated API.

For deployments behind a reverse proxy, set `NEXT_PUBLIC_ASGUARD_API_URL` to the browser-reachable HTTP(S) API origin and configure `ASGUARD_ALLOWED_ORIGINS` on the backend. Expose WebSocket upgrades for `/ws` through the same origin.

API credentials and the audit signing key are mandatory at backend startup. Use unique random values of at least 32 bytes; do not use the placeholder values from `.env.example`.
