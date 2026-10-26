import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateNearIntentPolicy, normalizeNearIntent } from './nearIntent';

const intent = {
  intent_type: 'swap',
  origin_asset: 'nep141:wrap.near',
  destination_asset: 'nep141:usdc.near',
  amount: '1000000000000000000000000',
  min_output_amount: '990000',
  recipient: 'alice.near',
  destination_chain: 'near',
  deadline: '2030-01-01T00:00:00.000Z',
  max_slippage_bps: 100,
  amount_usd: 25,
};

test('canonical NEAR intent hash is stable across object key order', () => {
  const normalized = normalizeNearIntent(intent, Date.parse('2029-01-01T00:00:00Z'));
  const reordered = normalizeNearIntent(Object.fromEntries(Object.entries(intent).reverse()), Date.parse('2029-01-01T00:00:00Z'));

  assert.equal(normalized.payloadHash, reordered.payloadHash);
  assert.equal(normalized.canonicalBytes, reordered.canonicalBytes);
  assert.equal(normalized.movement.amount_usd, 25);
  assert.equal(normalized.movement.destination_asset, 'nep141:usdc.near');
});

test('canonical NEAR intent hash binds all execution-relevant fields', () => {
  const changed = normalizeNearIntent({ ...intent, recipient: 'bob.near' }, Date.parse('2029-01-01T00:00:00Z'));
  const original = normalizeNearIntent(intent, Date.parse('2029-01-01T00:00:00Z'));

  assert.notEqual(changed.payloadHash, original.payloadHash);
});

test('malformed, expired, and unknown intent fields fail closed', () => {
  assert.throws(() => normalizeNearIntent({ ...intent, amount: '1.5' }), /smallest unit/);
  assert.throws(() => normalizeNearIntent({ ...intent, amount: '340282366920938463463374607431768211456' }), /smallest unit/);
  assert.throws(() => normalizeNearIntent({ ...intent, deadline: '2020-01-01T00:00:00Z' }), /future/);
  assert.throws(() => normalizeNearIntent({ ...intent, unsigned_payload: 'different bytes' }), /Unsupported/);
});

test('NEAR signed MultiPayload is decoded while its exact message stays hash-bound', () => {
  const signedIntent = {
    standard: 'nep413',
    payload: {
      recipient: 'intents.near',
      nonce: Buffer.alloc(32, 1).toString('base64'),
      message: JSON.stringify({
        deadline: '2030-01-01T00:00:00.000Z',
        intents: [{ intent: 'token_diff', diff: { 'nep141:wrap.near': '-1000000', 'nep141:arb-usdc.omft.near': '990000' } }],
        signer_id: 'alice.near',
      }),
    },
  };
  const normalized = normalizeNearIntent(signedIntent, Date.parse('2029-01-01T00:00:00Z'));
  const changed = normalizeNearIntent({
    ...signedIntent,
    payload: { ...signedIntent.payload, message: signedIntent.payload.message.replace('990000', '980000') },
  }, Date.parse('2029-01-01T00:00:00Z'));

  assert.equal(normalized.intent.intent_type, 'token_diff');
  assert.equal(normalized.movement.origin_asset, 'nep141:wrap.near');
  assert.equal(normalized.movement.destination_chain, 'arbitrum');
  assert.notEqual(normalized.payloadHash, changed.payloadHash);
});

test('NEAR intent policy blocks denied targets and requires review for unknown targets', () => {
  const normalized = normalizeNearIntent(intent, Date.parse('2029-01-01T00:00:00Z'));
  const policy = {
    max_auto_trade_usd: 100,
    strict_anomaly_detection: true,
    device_ip_lock: true,
    remote_trigger_protection: true,
    active_llm_engine: 'ollama' as const,
    denied_destinations: ['alice.near'],
    intent_unknown_target_requires_hitl: true,
  };

  const result = evaluateNearIntentPolicy(normalized, policy, new Date('2029-01-01T12:00:00Z'));
  assert.deepEqual(result.blockedReasons, ['destination_denied']);
  assert.equal(result.blocked, true);
  assert.equal(result.requiresHuman, true);
});

test('fully allow-listed NEAR intent can pass policy with a verified fresh USD value', () => {
  const normalized = normalizeNearIntent(intent, Date.parse('2029-01-01T00:00:00Z'));
  const policy = {
    max_auto_trade_usd: 100,
    strict_anomaly_detection: true,
    device_ip_lock: true,
    remote_trigger_protection: true,
    active_llm_engine: 'ollama' as const,
    allowed_intent_types: ['swap'],
    allowed_assets: ['nep141:wrap.near', 'nep141:usdc.near'],
    allowed_destinations: ['alice.near'],
    allowed_intent_chains: ['near'],
    max_slippage_bps: 100,
    allowed_intent_hours_utc: [12],
    intent_unknown_target_requires_hitl: true,
  };

  const result = evaluateNearIntentPolicy(normalized, policy, new Date('2029-01-01T12:00:00Z'), 25);
  assert.equal(result.blocked, false);
  assert.equal(result.requiresHuman, false);
  assert.deepEqual(result.humanReviewReasons, []);
});