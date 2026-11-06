import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntelligenceService } from './index';

test('intelligence is disabled by default and returns no output', async () => {
  const service = createIntelligenceService({ enabled: false });
  assert.equal(await service.analyze({ kind: 'approval', agent_id: 'agent-a' }), undefined);
});

test('heuristic fallback reports informational signals when enabled without provider config', async () => {
  const service = createIntelligenceService({ enabled: true });
  const result = await service.analyze({
    kind: 'approval', agent_id: 'agent-a', payload: { max_slippage_bps: 800 },
    details: { risk_level: 'high' },
  });
  assert.equal(result?.provider, 'heuristic');
  assert.ok(result?.signals.some((signal) => signal.code === 'bad_trade'));
  assert.ok(result?.signals.some((signal) => signal.code === 'unusual_behaviour'));
});

test('AI outage falls back to heuristics and does not throw', async () => {
  const service = createIntelligenceService({
    enabled: true, endpoint: 'https://api.near.ai/v1/chat/completions', apiKey: 'test-key', model: 'test-model',
    fetchImpl: async () => { throw new Error('offline'); },
  });
  const result = await service.analyze({
    kind: 'watch_activity', agent_id: 'agent-a', matched_approval: false,
    details: { direction: 'outbound', signer_id: 'alice.near', account_id: 'alice.near' },
  });
  assert.equal(result?.provider, 'heuristic');
  assert.equal(result?.signals[0]?.code, 'unmatched_activity');
});

test('provider output is constrained to known informational signals', async () => {
  const service = createIntelligenceService({
    enabled: true, endpoint: 'https://api.near.ai/v1/chat/completions', apiKey: 'test-key', model: 'test-model',
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      summary: 'Review the event.', signals: [
        { code: 'possible_bypass', confidence: 0.7, explanation: 'Suspicious metadata.' },
        { code: 'deny', confidence: 1, explanation: 'Must not control policy.' },
      ],
    }) } }] }), { status: 200 }),
  });
  const result = await service.analyze({ kind: 'approval', agent_id: 'agent-a' });
  assert.equal(result?.provider, 'near-ai');
  assert.deepEqual(result?.signals.map((signal) => signal.code), ['possible_bypass']);
});

test('NEAR AI receives the saved agent verification status as analysis context', async () => {
  let analyzedInput: Record<string, unknown> | undefined;
  const service = createIntelligenceService({
    enabled: true, endpoint: 'https://api.near.ai/v1/chat/completions', apiKey: 'test-key', model: 'test-model',
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      analyzedInput = JSON.parse(request.messages[2].content) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: 'Review complete.', signals: [] }) } }] }), { status: 200 });
    },
  });
  const agentVerification = { status: 'verified', updated_at: '2026-01-01T00:00:00.000Z' };
  await service.analyze({ kind: 'approval', agent_id: 'agent-a', details: { agent_verification: agentVerification } });
  assert.deepEqual((analyzedInput?.details as Record<string, unknown>).agent_verification, agentVerification);
});

test('verified USD context suppresses the unpriced-token signal', async () => {
  const service = createIntelligenceService({ enabled: true });
  const result = await service.analyze({ kind: 'approval', agent_id: 'agent-a', details: { verified_amount_usd: 2 } });
  assert.equal(result?.signals.some((signal) => signal.code === 'valueless_token'), false);
});

test('token signals use deterministic incoming and outgoing price and allowlist facts', async () => {
  const service = createIntelligenceService({ enabled: true });
  const result = await service.analyze({
    kind: 'approval', agent_id: 'agent-a',
    details: { token_facts: { value_out_usd: 10, value_in_usd: undefined, destination_verified: false } },
  });
  assert.ok(result?.signals.some((signal) => signal.code === 'valueless_token'));
  assert.ok(result?.signals.some((signal) => signal.code === 'new_contract'));
});

test('inbound wallet activity does not raise an unmatched-activity signal', async () => {
  const service = createIntelligenceService({ enabled: true });
  const result = await service.analyze({
    kind: 'watch_activity', agent_id: 'agent-a', matched_approval: false,
    details: { direction: 'inbound', signer_id: 'sender.near', account_id: 'watched.near' },
  });
  assert.equal(result?.signals.some((signal) => signal.code === 'unmatched_activity'), false);
});

test('configured AI endpoints must use HTTPS on a NEAR AI hostname', () => {
  assert.throws(() => createIntelligenceService({ enabled: true, endpoint: 'https://example.com', apiKey: 'key', model: 'model' }), /HTTPS.*near.ai/i);
  assert.throws(() => createIntelligenceService({ enabled: true, endpoint: 'http://api.near.ai', apiKey: 'key', model: 'model' }), /HTTPS.*near.ai/i);
});