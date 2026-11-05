import test from 'node:test';
import assert from 'node:assert/strict';
import { assertGeneratedSwapTransfer, buildTidepoolNearIntent, TidepoolClient, TIDEPOOL_TESTNET_URL, type TidepoolQuoteResponse } from './tidepool-client';

const response: TidepoolQuoteResponse = {
  correlationId: 'quote-123', timestamp: '2030-01-01T00:00:00.000Z', signature: 'ed25519:signature',
  quoteRequest: {
    dry: false, swapType: 'EXACT_INPUT', slippageTolerance: 100,
    originAsset: 'nep141:usdc.tidepool-sandbox.testnet', depositType: 'INTENTS',
    destinationAsset: 'nep141:wnear.tidepool-sandbox.testnet', amount: '100000',
    refundTo: 'alice.testnet', refundType: 'INTENTS', recipient: 'alice.testnet', recipientType: 'DESTINATION_CHAIN',
    deadline: '2030-01-01T00:10:00.000Z',
  },
  quote: {
    depositAddress: 'deposit-123', amountIn: '100000', amountInUsd: '0.1', amountOut: '1000', minAmountOut: '990',
    deadline: '2030-01-01T00:10:00.000Z',
  },
};

test('Tidepool client defaults to HTTPS and rejects insecure endpoints', () => {
  assert.equal(new TidepoolClient().getStatus instanceof Function, true);
  assert.equal(TIDEPOOL_TESTNET_URL, 'https://www.usetidepool.tech');
  assert.throws(() => new TidepoolClient({ baseUrl: 'http://www.usetidepool.tech' }), /HTTPS/);
});

test('Tidepool quote, token, and status calls use the 1Click-compatible paths and fields', async () => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const client = new TidepoolClient({ fetchImpl: async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url: `${url.origin}${url.pathname}${url.search}`, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.pathname.endsWith('/tokens')) return Response.json([{ assetId: response.quoteRequest.originAsset, decimals: 6, symbol: 'USDC' }]);
    if (url.pathname.endsWith('/quote')) return Response.json(response);
    return Response.json({ status: 'PENDING_DEPOSIT' });
  } });
  assert.equal((await client.listTokens())[0]?.symbol, 'USDC');
  await client.getQuote(response.quoteRequest);
  assert.equal((await client.getStatus('deposit-123')).status, 'PENDING_DEPOSIT');
  assert.deepEqual(calls.map(({ url, method }) => [url, method]), [
    ['https://www.usetidepool.tech/v0/tokens', 'GET'],
    ['https://www.usetidepool.tech/v0/quote', 'POST'],
    ['https://www.usetidepool.tech/v0/status?depositAddress=deposit-123', 'GET'],
  ]);
  assert.deepEqual(calls[1]?.body, response.quoteRequest);
});

test('Tidepool intent signing, submission, and intents faucet use documented bodies', async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const client = new TidepoolClient({ fetchImpl: async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname, body });
    if (url.pathname.endsWith('/generate-intent')) return Response.json({ intent: { standard: 'raw_ed25519', payload: 'unsigned payload' }, correlationId: 'generated-1' });
    if (url.pathname.endsWith('/status')) return Response.json({ status: 'SUCCESS' });
    return Response.json({ ok: true, intentHash: 'intent-1', tidepool: { txHash: 'tx-1' } });
  } });
  const generated = await client.generateIntent({ signerId: 'a'.repeat(64), depositAddress: 'deposit-1' });
  await client.requestFaucet({ accountId: 'a'.repeat(64), mode: 'intents', assets: ['USDC'] });
  await client.submitIntent({ standard: 'raw_ed25519', payload: generated.intent.payload, public_key: 'ed25519:pub', signature: 'ed25519:sig' });
  assert.deepEqual(calls.map((call) => call.path), ['/v0/generate-intent', '/v0/faucet', '/v0/submit-intent']);
  assert.deepEqual(calls[0]?.body, { type: 'swap_transfer', standard: 'raw_ed25519', signerId: 'a'.repeat(64), depositAddress: 'deposit-1' });
  assert.deepEqual(calls[1]?.body, { accountId: 'a'.repeat(64), mode: 'intents', assets: ['USDC'] });
  assert.deepEqual(calls[2]?.body, { type: 'swap_transfer', signedData: { standard: 'raw_ed25519', payload: 'unsigned payload', public_key: 'ed25519:pub', signature: 'ed25519:sig' } });
});

test('Tidepool failures are bounded and mapped to clear errors', async () => {
  const unavailable = new TidepoolClient({ fetchImpl: async () => Response.json({ message: 'rate limited' }, { status: 429 }) });
  await assert.rejects(unavailable.listTokens(), /Tidepool \/v0\/tokens failed \(rate limited\)/);
  const timedOut = new TidepoolClient({ timeoutMs: 100, fetchImpl: async (_input, init) => await new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }) });
  await assert.rejects(timedOut.listTokens(), /timed out/);
});

test('Tidepool status polling returns only after a final swap status', async () => {
  let polls = 0;
  const client = new TidepoolClient({ fetchImpl: async () => {
    polls += 1;
    return Response.json({ status: polls === 1 ? 'PROCESSING' : 'SUCCESS' });
  } });
  const status = await client.waitForFinalStatus('deposit-123', { timeoutMs: 1_000, pollIntervalMs: 1 });
  assert.equal(status.status, 'SUCCESS');
  assert.equal(polls, 2);
});

test('Tidepool quote maps into the normalizer shape and binds quote plus generated transfer intent', () => {
  const generated = { intent: { standard: 'raw_ed25519' as const, payload: JSON.stringify({
    signer_id: 'alice.testnet', verifying_contract: 'verifier.tidepool-sandbox.testnet',
    deadline: '2030-01-01T00:15:00.000Z', nonce: Buffer.alloc(32, 1).toString('base64'),
    intents: [{ intent: 'transfer', receiver_id: 'deposit-123', tokens: { [response.quoteRequest.originAsset]: response.quote.amountIn } }],
  }) }, correlationId: 'generated-1' };
  assert.equal(assertGeneratedSwapTransfer(response, generated, 'alice.testnet', 'verifier.tidepool-sandbox.testnet', Date.parse('2030-01-01T00:00:00Z')), true);
  const intent = buildTidepoolNearIntent(response, generated, 'verifier.tidepool-sandbox.testnet');
  assert.deepEqual({
    intent_type: intent.intent_type, origin_asset: intent.origin_asset, destination_asset: intent.destination_asset,
    amount: intent.amount, min_output_amount: intent.min_output_amount, recipient: intent.recipient,
    deadline: intent.deadline, quote_id: intent.quote_id, amount_usd: intent.amount_usd,
  }, {
    intent_type: 'swap', origin_asset: response.quoteRequest.originAsset, destination_asset: response.quoteRequest.destinationAsset,
    amount: '100000', min_output_amount: '990', recipient: 'alice.testnet', deadline: response.quote.deadline,
    quote_id: 'quote-123', amount_usd: 0.1,
  });
  assert.equal((intent.extensions as { tidepool: { generatedIntent: unknown; quoteSignature: string } }).tidepool.generatedIntent, generated.intent);
  assert.equal((intent.extensions as { tidepool: { quoteSignature: string } }).tidepool.quoteSignature, response.signature);
  const mismatched = { ...generated, intent: { ...generated.intent, payload: generated.intent.payload.replace('deposit-123', 'other-deposit') } };
  assert.throws(() => assertGeneratedSwapTransfer(response, mismatched, 'alice.testnet', 'verifier.tidepool-sandbox.testnet', Date.parse('2030-01-01T00:00:00Z')), /does not match/);
});
