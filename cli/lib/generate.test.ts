import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { generateAttestationKeyPair, randomSecretHex } from './generate';
import { parseApiCredentials } from '../../server/auth';
import { getAuditSigningKey } from '../../server/auditConfig';
import { validateApprovalKeyPair } from '../../server/attestationConfig';

test('generates unique 32-byte secrets and a verifiable Ed25519 keypair', () => {
  const first = randomSecretHex();
  const second = randomSecretHex();
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(Buffer.byteLength(first, 'utf8'), 64);
  assert.notEqual(first, second);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-keypair-'));
  try {
    const pair = generateAttestationKeyPair(directory);
    validateApprovalKeyPair(pair.privatePath, pair.publicPath);
    const privateKey = createPrivateKey(fs.readFileSync(pair.privatePath));
    const publicKey = createPublicKey(fs.readFileSync(pair.publicPath));
    const data = Buffer.from('ASGUARD key-pair test');
    assert.equal(verify(null, data, publicKey, sign(null, data, privateKey)), true);
    assert.throws(() => generateAttestationKeyPair(directory), /EEXIST/);
    const partialDirectory = path.join(directory, 'partial');
    fs.mkdirSync(partialDirectory);
    const existingPublic = path.join(partialDirectory, 'attestation-public.pem');
    fs.copyFileSync(pair.publicPath, existingPublic);
    assert.throws(() => generateAttestationKeyPair(partialDirectory), /EEXIST/);
    assert.equal(fs.existsSync(path.join(partialDirectory, 'attestation-private.pem')), false);
    assert.equal(fs.readFileSync(existingPublic, 'utf8'), fs.readFileSync(pair.publicPath, 'utf8'));
    const credentials = JSON.stringify([
      { id: 'runtime-local', token: first, roles: ['runtime'] },
      { id: 'dashboard-local', token: second, roles: ['admin', 'operator', 'auditor'] },
    ]);
    assert.equal(parseApiCredentials(credentials).length, 2);
    assert.equal(getAuditSigningKey(randomSecretHex()).length, 64);
    if (process.platform !== 'win32') assert.equal(fs.statSync(pair.privatePath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
