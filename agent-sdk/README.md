# ASGUARD agent SDK

Use `withAsguardApproval` in the trusted Node.js host that owns the agent's local signer. It requests approval over REST, polls pending HITL decisions, verifies the signed attestation against the exact payload and execution bindings, and invokes the callback only after every check passes. It never signs or submits by itself.

The SDK is exported as `asguard/agent-sdk` from the ASGUARD repository package. Keep this code in the host backend; do not import it into browser bundles. Supply only ASGUARD's Ed25519 public verification key to the host. The private key remains on the ASGUARD server, and the separate HMAC audit key is never used by the SDK.

## NEAR Intent integration

```ts
import { withAsguardApproval } from 'asguard/agent-sdk';
import { readFileSync } from 'node:fs';

const result = await withAsguardApproval({
  baseUrl: process.env.ASGUARD_API_URL!,
  token: process.env.ASGUARD_RUNTIME_TOKEN!,
  attestationPublicKey: readFileSync(process.env.ASGUARD_ATTESTATION_PUBLIC_KEY_PATH!, 'utf8'),
  agentId: 'swap-agent-01',
  agentName: 'Swap Agent',
  payloadDomain: 'near-intent',
  network: 'near:testnet',
  expectedVerifier: 'intents.near',
  idempotencyKey: crypto.randomUUID(),
  riskLevel: 'low',
  payload: exactNearIntent,
  expectedMaxAmountUsd: 250,
  onPendingHitl: (requestId) => console.info('Waiting for operator decision:', requestId),
}, async ({ attestation, canonicalPayload, decision }) => {
  // The host's own signer can run here. ASGUARD never receives its key.
  return hostSigner.signAndSubmit(canonicalPayload, attestation, decision);
});
```

The `expectedMaxAmountUsd` value is a host-side ceiling. If ASGUARD cannot verify a fresh price and the resulting attestation does not carry a value bound, the SDK rejects before the callback. Do not catch an approval error and continue to signing.

For host-built NEAR testnet transfers, the `near-transfer` payload domain hashes the exact serialized transfer description and is testnet-only. ASGUARD requires HITL for this generic NEAR signing request; the callback runs only after the SDK verifies the Ed25519 attestation. The host, not ASGUARD, signs and broadcasts.

## Chain Signatures integration

```ts
const result = await withAsguardApproval({
  baseUrl: process.env.ASGUARD_API_URL!,
  token: process.env.ASGUARD_RUNTIME_TOKEN!,
  attestationPublicKey: readFileSync(process.env.ASGUARD_ATTESTATION_PUBLIC_KEY_PATH!, 'utf8'),
  agentId: 'swap-agent-01',
  agentName: 'Swap Agent',
  payloadDomain: 'near-chain-signature',
  network: 'ethereum:mainnet',
  chain: 'ethereum',
  derivationPath: 'ethereum,1',
  signerContract: process.env.ASGUARD_NEAR_CHAIN_SIGNATURES_CONTRACT!,
  idempotencyKey: crypto.randomUUID(),
  riskLevel: 'high',
  payload: exactUnsignedTransactionBytes,
}, async ({ attestation, canonicalPayload, decision }) => {
  return hostChainSignatureClient.requestSignature(canonicalPayload, attestation, decision);
});
```

The host must build and retain the exact unsigned payload bytes used to derive the approved hash. Foreign-chain requests require HITL by default. ASGUARD does not invoke the Chain Signatures signer contract or MPC.

## Wrong and right

Wrong: call the wallet first, then ask ASGUARD to log what happened. That is not pre-approval.

Right: call `withAsguardApproval` with the exact intent/bytes and put every signing or submission operation inside its callback. The callback cannot run after a rejection, timeout, missing attestation, invalid signature, expired attestation, changed payload, or mismatched binding.

`baseUrl`, runtime `token`, `attestationPublicKey`, `agentId`, `agentName`, exact `payload`, `payloadDomain`, `network`, `idempotencyKey`, and `riskLevel` are required. NEAR Intent additionally requires `expectedVerifier`; Chain Signatures requires `chain`, `derivationPath`, and `signerContract`. `pollIntervalMs`, `timeoutMs`, `onPendingHitl`, `expectedMaxAmountUsd`, `ipAddress`, and `deviceId` are optional. The runtime token is used only by this server-side helper and is never logged. The SDK has no audit-key or attestation-private-key input.
