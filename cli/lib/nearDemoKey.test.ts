import test from 'node:test';
import assert from 'node:assert/strict';
import { createNearRawEd25519Signer } from '../../scripts/nearRawSigner';
import { generateNearDemoKeyPair, nearDemoAccountId, nearDemoKeyMatches } from './nearDemoKey';

test('setup-generated NEAR implicit key matches the Tidepool raw signer format', () => {
  const pair = generateNearDemoKeyPair();
  assert.match(pair.accountId, /^[a-f0-9]{64}$/);
  assert.equal(nearDemoAccountId(pair.privateKey), pair.accountId);
  assert.equal(nearDemoKeyMatches(pair.privateKey, pair.accountId), true);
  assert.equal(nearDemoKeyMatches(pair.privateKey, '0'.repeat(64)), false);
  assert.equal(createNearRawEd25519Signer(pair.privateKey).accountId, pair.accountId);
});
