import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { withAsguardApproval } from '../agent-sdk/index';
import { runDemo } from './demo-common';

interface NearApiModule {
  connect(config: { networkId: string; nodeUrl: string; keyStore: unknown }): Promise<{
    account(accountId: string): Promise<{ sendMoney(receiverId: string, amount: string): Promise<unknown> }>;
  }>;
  KeyPair: { fromString(value: string): unknown };
  keyStores: { InMemoryKeyStore: new () => { setKey(networkId: string, accountId: string, keyPair: unknown): Promise<void> } };
  utils: { format: { parseNearAmount(value: string): string | null } };
}

const agentId = 'asguard-near-testnet-submit-demo';

if (process.env.ASGUARD_DEMO_SUBMIT !== 'true') {
  console.error('[ASGUARD demo] Submission demo is disabled. Set ASGUARD_DEMO_SUBMIT=true in local .env only after reviewing the testnet safeguards.');
  process.exitCode = 1;
} else void runDemo('demo:near:approve:submit', async (config) => {
  if (process.env.ASGUARD_DEMO_SUBMIT !== 'true') {
    throw new Error('Submission demo is disabled. Set ASGUARD_DEMO_SUBMIT=true in local .env only after reviewing the testnet safeguards.');
  }
  if (config.network !== 'near:testnet') throw new Error('Submission demo is testnet-only.');

  const accountId = process.env.ASGUARD_DEMO_NEAR_ACCOUNT_ID?.trim();
  const privateKey = process.env.ASGUARD_DEMO_NEAR_PRIVATE_KEY?.trim();
  const receiverId = process.env.ASGUARD_DEMO_NEAR_RECIPIENT?.trim();
  const amountNear = process.env.ASGUARD_DEMO_NEAR_AMOUNT?.trim() || '0.001';
  if (!accountId || !privateKey || !receiverId) {
    throw new Error('Set ASGUARD_DEMO_NEAR_ACCOUNT_ID, ASGUARD_DEMO_NEAR_PRIVATE_KEY, and ASGUARD_DEMO_NEAR_RECIPIENT in local .env. The private key is consumed only by this host demo process.');
  }
  const validAccount = (value: string) => value.length >= 2 && value.length <= 64 && /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(value);
  if (!validAccount(accountId) || !validAccount(receiverId)) throw new Error('Demo sender and recipient must be valid NEAR account IDs.');
  const amountParts = amountNear.split('.');
  if (amountParts.length > 2 || !/^\d+$/.test(amountParts[0] ?? '') || (amountParts[1] !== undefined && !/^\d{1,24}$/.test(amountParts[1]))) {
    throw new Error('ASGUARD_DEMO_NEAR_AMOUNT must be a positive NEAR decimal with at most 24 fractional digits.');
  }
  const amountPartsValue = amountNear.split('.');
  const amountYocto = amountPartsValue[1] === undefined
    ? `${amountPartsValue[0]}${'0'.repeat(24)}`
    : `${amountPartsValue[0]}${amountPartsValue[1].padEnd(24, '0')}`;
  if (!amountYocto || BigInt(amountYocto) <= 0n || BigInt(amountYocto) > 10n ** 22n) {
    throw new Error('Demo transfer must be greater than zero and no more than 0.01 NEAR.');
  }

  const registration = await fetch(`${config.apiUrl}/api/agents/connect`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.runtimeToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, agent_name: 'ASGUARD testnet submission demo', network: config.network, account_ids: [accountId] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!registration.ok) throw new Error(`Could not register the demo host with ASGUARD (HTTP ${registration.status}).`);

  const transfer = { sender: accountId, receiver: receiverId, amount: amountYocto };
  console.log(`Requesting human-reviewed approval for a ${amountNear} NEAR testnet transfer from ${accountId} to ${receiverId}.`);
  console.log('The backend will not sign or broadcast. The demo host signs only inside the SDK callback after attestation verification.');

  await withAsguardApproval({
    baseUrl: config.apiUrl,
    token: config.runtimeToken,
    attestationPublicKey: config.attestationPublicKey,
    agentId,
    agentName: 'ASGUARD testnet submission demo',
    action: 'near-testnet-transfer',
    payload: transfer,
    payloadDomain: 'near-transfer',
    network: config.network,
    idempotencyKey: `near-submit-${randomUUID()}`,
    riskLevel: 'high',
    timeoutMs: 180_000,
    pollIntervalMs: 1_000,
    onPendingHitl: (requestId) => console.log(`HITL pending: request_id=${requestId}; approve in the dashboard within 3 minutes.`),
  }, async ({ attestation, canonicalPayload, decision }) => {
    if (process.env.ASGUARD_DEMO_SUBMIT !== 'true' || process.env.ASGUARD_NEAR_NETWORK !== 'testnet') {
      throw new Error('Submission safeguards changed before host signing; refusing to submit.');
    }
    if (JSON.stringify(canonicalPayload) !== JSON.stringify(transfer)) throw new Error('Verified transfer terms differ from the requested transfer.');

    const nearApi = createRequire(`${process.cwd()}/package.json`)('near-api-js') as NearApiModule;
    const keyStore = new nearApi.keyStores.InMemoryKeyStore();
    await keyStore.setKey('testnet', accountId, nearApi.KeyPair.fromString(privateKey));
    const near = await nearApi.connect({ networkId: 'testnet', nodeUrl: process.env.ASGUARD_NEAR_RPC_URL || 'https://rpc.testnet.near.org', keyStore });
    const outcome = await (await near.account(accountId)).sendMoney(receiverId, amountYocto);
    const txHash = (outcome as { transaction?: { hash?: unknown } }).transaction?.hash;
    if (typeof txHash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(txHash)) {
      throw new Error('NEAR host SDK returned no valid transaction hash; do not report an unconfirmed submission.');
    }

    const report = await fetch(`${config.apiUrl}/api/submissions/report`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.runtimeToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent_id: decision.intentId, payload_hash: attestation.payload_hash, tx_hash: txHash }),
      signal: AbortSignal.timeout(10_000),
    });
    const response = await report.json().catch(() => ({})) as { error?: string; intent?: { status?: string; tx_hash?: string } };
    if (!report.ok) throw new Error(response.error || `ASGUARD rejected the transaction report (HTTP ${report.status}).`);
    console.log(JSON.stringify({
      status: response.intent?.status,
      tx_hash: response.intent?.tx_hash,
      network: config.network,
      attestation_verified: true,
      broadcast_by: 'trusted demo host via near-api-js',
    }, null, 2));
  });
});