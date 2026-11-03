import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { buildPublicKeyResponse } from './attestationPublicKey';

test('builds a public Ed25519 key response with an independently verifiable SPKI fingerprint', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const response = buildPublicKeyResponse(publicKey);
  const der = publicKey.export({ type: 'spki', format: 'der' });
  assert.deepEqual(Object.keys(response).sort(), ['algorithm', 'fingerprint_sha256', 'public_key_pem']);
  assert.equal(response.algorithm, 'ed25519');
  assert.equal(response.fingerprint_sha256, createHash('sha256').update(der).digest('hex'));
  assert.equal(response.public_key_pem.includes('PUBLIC KEY'), true);
  assert.equal(response.public_key_pem.includes('PRIVATE KEY'), false);
  assert.equal(JSON.stringify(response).includes(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()), false);
});

test('rejects private and non-Ed25519 KeyObjects', () => {
  const ed25519 = generateKeyPairSync('ed25519');
  assert.throws(() => buildPublicKeyResponse(ed25519.privateKey), /public key/);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => buildPublicKeyResponse(rsa.publicKey), /Ed25519/);
});
