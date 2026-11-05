import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { createNearRawEd25519Signer, decodeBase58, encodeBase58 } from './nearRawSigner';

const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');

test('base58 round-trips leading zero bytes', () => {
  const bytes = Buffer.from([0, 0, 1, 2, 255]);
  assert.deepEqual(decodeBase58(encodeBase58(bytes)), bytes);
});

test('NEAR raw signer derives the implicit account and signs Tidepool payload bytes', () => {
  const seed = Buffer.alloc(32, 7);
  const privateKey = createPrivateKey({ key: Buffer.concat([prefix, seed]), format: 'der', type: 'pkcs8' });
  const publicBytes = Buffer.from(createPublicKey(privateKey).export({ format: 'der', type: 'spki' })).subarray(-32);
  const nearSecret = encodeBase58(Buffer.concat([seed, publicBytes]));
  const signer = createNearRawEd25519Signer(`ed25519:${nearSecret}`);
  const signature = decodeBase58(signer.sign('exact Tidepool payload').slice('ed25519:'.length));
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicBytes]), format: 'der', type: 'spki' });
  assert.equal(signer.accountId, publicBytes.toString('hex'));
  assert.equal(signer.publicKey, `ed25519:${encodeBase58(publicBytes)}`);
  assert.equal(verify(null, Buffer.from('exact Tidepool payload'), publicKey, signature), true);
  assert.throws(() => createNearRawEd25519Signer(`ed25519:${encodeBase58(Buffer.concat([seed, Buffer.alloc(32, 1)]))}`), /mismatched/);
});
