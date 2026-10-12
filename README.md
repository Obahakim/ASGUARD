# Asguard / Payguard

Asguard is a security monitoring service with behavioral profiles, deterministic evaluation, a cryptographic audit trail, human review, and a real-time operator dashboard. The `Payguard` branch adapts that architecture for PayPal-style account and payment activity.

## Payguard: PayPal AI Hackathon

Payguard protects both personal consumers and business merchants. The ingestion adapter supplies `account_type` (`personal` or `business`) and `event_direction` (`incoming` or `outgoing`) from PayPal's existing account and payment context; operators do not switch modes. The REST and MCP activity interfaces accept these fields directly. Legacy events default to personal-account handling.

Personal-account rules focus on account takeover and consumer loss: unfamiliar IP/device, high or unusual outgoing amount, account-event velocity, and sensitive account changes (including a payment soon after a password change). Business incoming-payment rules focus on chargeback exposure: configured high-risk BINs, payer/instrument velocity, payer-versus-instrument or historical geographic mismatch, known-bad instrument fingerprints, and unusually large receipts. Payer-side velocity and country history are profiled across merchants in the same `ProfileManager`.

Deterministic findings run first. Jev receives the event account type and direction, then asks consumer questions for personal activity or merchant questions for incoming business payments, including chargeback probability, instrument risk, and a merchant action (`accept`, `accept-with-review`, `challenge`, or `decline`). Merchant actions map onto Payguard's common graduated outcomes (`allow`, `notify`, `challenge`, `hold`). The rules score is blended with Jev's risk probabilities; the final decision keeps the most protective rule, score, or Jev action. If Jev is not configured or unavailable, deterministic evaluation continues and records the Jev status. Both paths use the same audit trail, WebSocket dashboard, policy, and HITL workflows.

For merchant controls, configure `high_risk_bins` and `blocked_instrument_fingerprints` in the payment security policy. Send tokenized fingerprints only; never send card numbers (PANs) or CVVs.

Set `TYPESAFE_API_KEY` on the backend to enable Jev. The official `@typesafe-ai/sdk` client uses the `jev-latest` model by default. Keep the key server-side; it is never required by the browser dashboard.

### Report activity

Authenticated runtimes can post to `POST /api/events/activity` (the legacy `/api/events/agent-activity` route remains available):

```json
{
  "account_id": "paypal-user-1042",
  "event_type": "transaction",
  "account_type": "business",
  "event_direction": "incoming",
  "amount": 725.5,
  "currency": "USD",
  "ip_address": "203.0.113.8",
  "device_id": "device-7f3a",
  "location": "Lagos, NG",
  "merchant_id": "merchant-88",
  "transaction_id": "txn-20481",
  "payer_id": "payer-88",
  "instrument_fingerprint": "processor-token-fingerprint",
  "card_bin": "411111",
  "payer_country": "NG",
  "instrument_country": "US"
}
```

Personal account behavior baselines mature after five observations; merchant instrument, BIN, and country signals can trigger from the first receipt. The response includes the common graduated recommendation, a merchant-specific recommendation when applicable, rule explanations, and Jev assessment status. Challenge/hold findings feed human review; events and assessments are written to the audit anchor and anomaly audit chain.

## Development

```sh
pnpm install
pnpm dev
```

The dashboard runs on port 3000 and the authenticated API/WebSocket service on port 8080. Configure the repository's normal `ASGUARD_*` API credentials and allowed origins before connecting an operator dashboard.
