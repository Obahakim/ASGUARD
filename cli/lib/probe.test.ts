import test from 'node:test';
import assert from 'node:assert/strict';
import { probeNearAi, probeRpc } from './probe';

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('probes RPC block height and reports non-200 responses', async () => {
  assert.equal(await probeRpc('https://rpc.example.test', async () =>
    reply(200, { result: { sync_info: { latest_block_height: 7 } } })), 'block 7');
  await assert.rejects(probeRpc('https://rpc.example.test', async () => reply(503, {})), /HTTP 503/);
});

test('NEAR AI probe handles success, HTTP error, malformed JSON, and timeout without key disclosure', async () => {
  const key = 'never-print-this-ai-key';
  const options = { endpoint: 'https://api.near.ai/v1/chat/completions', model: 'test-model', apiKey: key };
  const success = await probeNearAi({ ...options, fetchImpl: async () => reply(200, {
    choices: [{ message: { content: '{"summary":"ok","signals":[]}' } }],
  }) });
  const httpFailure = await probeNearAi({ ...options, fetchImpl: async () => reply(401, {}) });
  const malformed = await probeNearAi({ ...options, fetchImpl: async () => reply(200, {
    choices: [{ message: { content: 'not JSON' } }],
  }) });
  const timeout = await probeNearAi({ ...options, fetchImpl: async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); } });
  assert.equal(success.ok, true);
  assert.equal(httpFailure.status, 401);
  assert.equal(malformed.ok, false);
  assert.equal(timeout.ok, false);
  for (const result of [success, httpFailure, malformed, timeout]) assert.equal(JSON.stringify(result).includes(key), false);
});
