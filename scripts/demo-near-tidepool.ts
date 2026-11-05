import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { connectAgent, withAsguardApproval } from '../agent-sdk/index';
import { assertApprovedThenSignIntent } from '../server/approvalAttestation';
import { normalizeNearIntent } from '../server/aos/nearIntent';
import { nearIntentsDefaults } from '../server/aos/nearIntentsConfig';
import { createNearRawEd25519Signer } from './nearRawSigner';
import { runDemo } from './demo-common';
import { assertGeneratedSwapTransfer, buildTidepoolNearIntent, TidepoolClient, TIDEPOOL_TESTNET_URL, type TidepoolQuoteRequest } from './tidepool-client';

const mode = process.argv[2] || 'approve';
const AGENT_ID = 'asguard-tidepool-testnet-demo';
const APPROVAL_AMOUNT_USD_CAP = 2;
const QUOTE_AMOUNT = '100000'; // 0.1 USDC (6 decimals)
const ORIGIN_ASSET = 'nep141:usdc.tidepool-sandbox.testnet';
const DESTINATION_ASSET = 'nep141:wnear.tidepool-sandbox.testnet';

function ephemeralSignerId(): string {
  const pair = generateKeyPairSync('ed25519');
  const der = Buffer.from(pair.publicKey.export({ format: 'der', type: 'spki' }));
  return der.subarray(-32).toString('hex');
}

function approvedSigner() {
  const privateKey = process.env.ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY?.trim();
  const accountId = process.env.ASGUARD_DEMO_TIDEPOOL_ACCOUNT_ID?.trim();
  if (!privateKey || !accountId) throw new Error('Set ASGUARD_DEMO_TIDEPOOL_ACCOUNT_ID to the key’s 64-character implicit NEAR account ID and ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY to ed25519:<base58 secret>. The key is used only in this host process.');
  const signer = createNearRawEd25519Signer(privateKey);
  if (signer.accountId !== accountId) throw new Error('ASGUARD_DEMO_TIDEPOOL_ACCOUNT_ID does not match the public key in ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY.');
  return signer;
}

function requireQuoteLimit(amountUsd: string): void {
  const value = Number(amountUsd);
  if (!Number.isFinite(value) || value < 0 || value > APPROVAL_AMOUNT_USD_CAP) {
    throw new Error(`Tidepool quote exceeds the demo cap of $${APPROVAL_AMOUNT_USD_CAP.toFixed(2)}.`);
  }
}

function tamperIntent(input: Record<string, unknown>): Record<string, unknown> {
  const extension = input.extensions as { tidepool: Record<string, unknown> };
  const generated = extension.tidepool.generatedIntent as { standard: 'raw_ed25519'; payload: string };
  const changedPayload = JSON.parse(generated.payload) as Record<string, unknown>;
  const originalIntents = changedPayload.intents as Array<Record<string, unknown>>;
  const transfer = originalIntents[0];
  const tokens = transfer?.tokens as Record<string, string>;
  const amountAsset = Object.keys(tokens)[0];
  const changedTokens = { ...tokens, [amountAsset]: (BigInt(tokens[amountAsset] || '0') + 1n).toString() };
  const changedGenerated = { ...generated, payload: JSON.stringify({ ...changedPayload, intents: [{ ...transfer, tokens: changedTokens }] }) };
  return {
    ...input,
    amount: (BigInt(String(input.amount)) + 1n).toString(),
    extensions: { tidepool: { ...extension.tidepool, generatedIntent: changedGenerated } },
  };
}

void runDemo(`demo:near:tidepool:${mode}`, async (config) => {
  if (mode !== 'approve' && mode !== 'tamper') throw new Error('Usage: npm run demo:near:tidepool:approve | npm run demo:near:tidepool:tamper.');
  if (config.network !== 'near:testnet') throw new Error('Tidepool demos are testnet-only; no mainnet quote or settlement is allowed.');
  const tidepoolDefaults = nearIntentsDefaults('testnet', true);
  if (config.intentsApiUrl.replace(/\/$/, '') !== TIDEPOOL_TESTNET_URL
    || config.verifier !== tidepoolDefaults.verifier) {
    throw new Error(`This Tidepool demo needs Tidepool URL/verifier configuration. Re-run npm run setup and opt into the Tidepool demo key, or set ASGUARD_NEAR_INTENTS_API_URL=${TIDEPOOL_TESTNET_URL} and ASGUARD_NEAR_INTENTS_VERIFIER=${tidepoolDefaults.verifier} manually.`);
  }

  const settle = mode === 'approve' && process.env.ASGUARD_DEMO_TIDEPOOL_SETTLE === 'true';
  if (mode === 'tamper' && process.env.ASGUARD_DEMO_TIDEPOOL_SETTLE === 'true') {
    console.log('Tamper mode never signs or submits, even when Tidepool settlement is enabled.');
  }
  const signer = settle ? approvedSigner() : undefined;
  const signerId = signer?.accountId ?? ephemeralSignerId();
  const client = new TidepoolClient({ baseUrl: TIDEPOOL_TESTNET_URL, timeoutMs: 12_000 });

  const health = await client.health();
  if (health.network !== 'testnet' || health.verifier !== config.verifier) {
    throw new Error(`Tidepool health mismatch: network=${health.network}, verifier=${health.verifier}. Refusing to request an approval.`);
  }
  const tokens = await client.listTokens();
  for (const assetId of [ORIGIN_ASSET, DESTINATION_ASSET]) {
    if (!tokens.some((token) => token.assetId === assetId)) throw new Error(`Tidepool currently does not list required demo asset ${assetId}.`);
  }

  await connectAgent({
    baseUrl: config.apiUrl, token: config.runtimeToken, agentId: AGENT_ID,
    agentName: 'ASGUARD Tidepool testnet demo', network: config.network, accountIds: [signerId],
  });
  console.log(`Registered demo account ${signerId} with ASGUARD before requesting a swap approval.`);

  if (settle && process.env.ASGUARD_DEMO_TIDEPOOL_FAUCET === 'true') {
    const funding = await client.requestFaucet({ accountId: signerId, mode: 'intents', assets: ['USDC'] });
    console.log(`Tidepool intents faucet requested: ${JSON.stringify(funding)}`);
  }

  const quoteRequest: TidepoolQuoteRequest = {
    dry: false,
    swapType: 'EXACT_INPUT',
    slippageTolerance: 100,
    originAsset: ORIGIN_ASSET,
    depositType: 'INTENTS',
    destinationAsset: DESTINATION_ASSET,
    amount: QUOTE_AMOUNT,
    refundTo: signerId,
    refundType: 'INTENTS',
    recipient: signerId,
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
  const quoteResponse = await client.getQuote(quoteRequest);
  requireQuoteLimit(quoteResponse.quote.amountInUsd);
  const generated = await client.generateIntent({ signerId, depositAddress: quoteResponse.quote.depositAddress });
  assertGeneratedSwapTransfer(quoteResponse, generated, signerId, config.verifier);
  const payload = buildTidepoolNearIntent(quoteResponse, generated, config.verifier);
  console.log(JSON.stringify({
    provider: 'Tidepool community testnet sandbox', base_url: TIDEPOOL_TESTNET_URL,
    quote_id: quoteResponse.correlationId, origin_asset: ORIGIN_ASSET, destination_asset: DESTINATION_ASSET,
    amount_in: quoteResponse.quote.amountIn, amount_in_usd: quoteResponse.quote.amountInUsd,
    min_amount_out: quoteResponse.quote.minAmountOut, recipient: signerId,
    deposit_address: quoteResponse.quote.depositAddress, settle_enabled: settle,
  }, null, 2));

  await withAsguardApproval({
    baseUrl: config.apiUrl, token: config.runtimeToken, attestationPublicKey: config.attestationPublicKey,
    agentId: AGENT_ID, agentName: 'ASGUARD Tidepool testnet demo',
    action: mode === 'tamper' ? 'tidepool-swap-tamper-demo' : 'tidepool-testnet-swap',
    payload, payloadDomain: 'near-intent', network: config.network, expectedVerifier: config.verifier,
    idempotencyKey: `tidepool-${mode}-${createHash('sha256').update(quoteResponse.correlationId).digest('hex').slice(0, 32)}`,
    riskLevel: 'high', expectedMaxAmountUsd: APPROVAL_AMOUNT_USD_CAP,
    timeoutMs: 180_000, pollIntervalMs: 1_000,
    onPendingHitl: (requestId) => console.log(`HITL pending: request_id=${requestId}; resolve in the dashboard within 3 minutes.`),
  }, async ({ attestation, canonicalPayload, decision }) => {
    assertApprovedThenSignIntent(payload, attestation, {
      publicKey: config.attestationPublicKey, expectedAgentId: AGENT_ID,
      expectedNetwork: config.network, expectedVerifier: config.verifier,
    });
    if (mode === 'tamper') {
      const payloadB = tamperIntent(payload);
      assert.throws(() => assertApprovedThenSignIntent(payloadB, attestation, {
        publicKey: config.attestationPublicKey, expectedAgentId: AGENT_ID,
        expectedNetwork: config.network, expectedVerifier: config.verifier,
      }), /payload_hash_mismatch/);
      console.log('PASS: attestation/payload binding rejected change after approval. Payload B was not signed or submitted.');
      console.log(JSON.stringify({ status: 'tamper_rejected', approved_payload_hash: attestation.payload_hash, callback_completed: false, submission_attempted: false }, null, 2));
      return;
    }

    console.log(JSON.stringify({ status: 'approved', request_id: decision.requestId ?? null, payload_hash: attestation.payload_hash }, null, 2));
    if (!settle) {
      console.log('Approval-only run complete. No signing, submission, or value movement occurred. Set ASGUARD_DEMO_TIDEPOOL_SETTLE=true to enable the capped host-side testnet settlement.');
      return;
    }
    if (!signer || process.env.ASGUARD_DEMO_TIDEPOOL_SETTLE !== 'true' || process.env.ASGUARD_NEAR_NETWORK !== 'testnet') {
      throw new Error('Tidepool settlement safeguards changed before signing; refusing to submit.');
    }
    const expectedCanonical = normalizeNearIntent(payload, Date.now(), config.verifier).intent;
    if (JSON.stringify(canonicalPayload) !== JSON.stringify(expectedCanonical)) throw new Error('Verified Tidepool quote differs from the approved payload.');
    requireQuoteLimit(quoteResponse.quote.amountInUsd);
    assertGeneratedSwapTransfer(quoteResponse, generated, signerId, config.verifier);
    const signature = signer.sign(generated.intent.payload);
    const publicKey = signer.publicKey;
    const submission = await client.submitIntent({
      standard: 'raw_ed25519', payload: generated.intent.payload,
      public_key: publicKey, signature,
    });
    const tidepool = typeof submission.tidepool === 'object' && submission.tidepool !== null
      ? submission.tidepool as Record<string, unknown> : {};
    console.log(JSON.stringify({ status: 'submitted', tx_hash: tidepool.txHash ?? submission.intentHash ?? null, explorer_url: tidepool.explorerUrl ?? null }, null, 2));
    const finalStatus = await client.waitForFinalStatus(quoteResponse.quote.depositAddress, { timeoutMs: 180_000, pollIntervalMs: 3_000 });
    console.log(JSON.stringify({ status: finalStatus.status, updated_at: finalStatus.updatedAt ?? null, swap_details: finalStatus.swapDetails ?? null }, null, 2));
    if (finalStatus.status !== 'SUCCESS') throw new Error(`Tidepool swap finished with ${finalStatus.status}; inspect the Tidepool status response and testnet explorer.`);
  });
});
