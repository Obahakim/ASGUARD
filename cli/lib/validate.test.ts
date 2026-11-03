import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEndpoint, validateNearAiEndpoint } from './validate';

test('matches backend HTTPS validation and permits local development HTTP', () => {
  assert.equal(validateEndpoint('RPC', 'https://rpc.example.test').protocol, 'https:');
  assert.equal(validateEndpoint('RPC', 'http://localhost:8080').protocol, 'http:');
  assert.equal(validateEndpoint('RPC', 'http://127.0.0.1:8080').protocol, 'http:');
  assert.throws(() => validateEndpoint('RPC', 'http://example.test'), /HTTPS/);
  assert.throws(() => validateEndpoint('RPC', 'ftp://example.test'), /HTTPS|valid HTTP/);
});

test('rejects http IPv6 loopback to match start-backend', () => {
  // This mirrors an existing server quirk: URL.hostname includes brackets for IPv6 loopback.
  assert.throws(() => validateEndpoint('X', 'http://[::1]:8080'), /HTTPS/);
});

test('validates NEAR AI scheme and hostname', () => {
  assert.equal(validateNearAiEndpoint('https://api.near.ai/v1/chat/completions').hostname, 'api.near.ai');
  assert.throws(() => validateNearAiEndpoint('https://near.ai.attacker.test'), /near.ai/);
  assert.throws(() => validateNearAiEndpoint('http://api.near.ai'), /HTTPS/);
});
