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
    enabled: true, endpoint: 'https://near-ai.invalid', apiKey: 'test-key', model: 'test-model',
    fetchImpl: async () => { throw new Error('offline'); },
  });
  const result = await service.analyze({ kind: 'watch_activity', agent_id: 'agent-a', matched_approval: false });
  assert.equal(result?.provider, 'heuristic');
  assert.equal(result?.signals[0]?.code, 'unmatched_activity');
});

test('provider output is constrained to known informational signals', async () => {
  const service = createIntelligenceService({
    enabled: true, endpoint: 'https://near-ai.invalid', apiKey: 'test-key', model: 'test-model',
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

test('verified USD context suppresses the unpriced-token signal', async () => {
  const service = createIntelligenceService({ enabled: true });
  const result = await service.analyze({ kind: 'approval', agent_id: 'agent-a', details: { verified_amount_usd: 2 } });
  assert.equal(result?.signals.some((signal) => signal.code === 'valueless_token'), false);
});