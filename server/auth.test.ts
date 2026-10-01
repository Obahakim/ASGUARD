import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApiAuthenticator, parseApiCredentials } from './auth';
import { getAuditSigningKey } from './auditConfig';
import { AuditChain } from './auditChain';

const runtimeToken = 'a-long-enough-runtime-token-value-123456';
const adminToken = 'a-long-enough-admin-token-value-123456';
const credentials = [
  { id: 'runtime-prod', token: runtimeToken, roles: ['runtime'] as const },
  { id: 'ops-admin', token: adminToken, roles: ['admin', 'operator', 'auditor'] as const },
];

test('parses named credentials and rejects missing, weak, or invalid configuration', () => {
  assert.throws(() => parseApiCredentials(''), /ASGUARD_API_CREDENTIALS/i);
  assert.throws(() => parseApiCredentials('not-json'), /valid JSON/i);
  assert.throws(() => parseApiCredentials(JSON.stringify([
    { id: 'runtime', token: 'short', roles: ['runtime'] },
  ])), /32 bytes/i);
  assert.equal(parseApiCredentials(JSON.stringify(credentials))[0].id, 'runtime-prod');
});

test('authenticates a named runtime identity and rejects invalid tokens', () => {
  const authenticator = new ApiAuthenticator([...credentials]);
  assert.deepEqual(
    authenticator.authenticate({ headers: { authorization: `Bearer ${runtimeToken}` } } as any),
    { id: 'runtime-prod', roles: ['runtime'] }
  );
  assert.throws(
    () => authenticator.authenticate({ headers: { authorization: 'Bearer invalid' } } as any),
    /Invalid or expired token/i
  );
});

test('enforces role-based permissions for runtime and admin identities', () => {
  const authenticator = new ApiAuthenticator([...credentials]);
  const runtimeRequest = {
    asguardIdentity: authenticator.authenticate({ headers: { authorization: `Bearer ${runtimeToken}` } } as any),
  } as any;
  const adminRequest = {
    asguardIdentity: authenticator.authenticate({ headers: { authorization: `Bearer ${adminToken}` } } as any),
  } as any;
  let runtimeAllowed = false;
  let adminAllowed = false;
  let runtimeDeniedStatus = 0;
  const response = () => ({
    status(code: number) {
      runtimeDeniedStatus = code;
      return this;
    },
    json() {},
  });

  authenticator.requireAnyRole('runtime', 'admin')(runtimeRequest, response() as any, () => { runtimeAllowed = true; });
  authenticator.requireAnyRole('admin')(runtimeRequest, response() as any, () => {});
  authenticator.requireAnyRole('admin')(adminRequest, response() as any, () => { adminAllowed = true; });

  assert.equal(runtimeAllowed, true);
  assert.equal(runtimeDeniedStatus, 403);
  assert.equal(adminAllowed, true);
});

test('rejects missing or weak audit signing keys', () => {
  assert.throws(() => getAuditSigningKey(''), /ASGUARD_AUDIT_KEY/i);
  assert.throws(() => getAuditSigningKey('too-short'), /32 bytes/i);
  assert.equal(getAuditSigningKey('a-long-enough-test-audit-key-value-123456'), 'a-long-enough-test-audit-key-value-123456');
});

test('persists audit entries and rejects a tampered chain on reload', () => {
  const originalKey = process.env.ASGUARD_AUDIT_KEY;
  const directory = mkdtempSync(join(tmpdir(), 'asguard-audit-'));
  const chainPath = join(directory, 'audit.json');
  process.env.ASGUARD_AUDIT_KEY = 'a-long-enough-test-audit-key-value-123456';

  try {
    const chain = new AuditChain(chainPath);
    chain.addEntry('event-1', 'agent-1', 'tool-call', 10);
    assert.equal(chain.verifyChainIntegrity(), true);

    const stored = JSON.parse(readFileSync(chainPath, 'utf8'));
    stored.entries[0].action = 'tampered';
    writeFileSync(chainPath, JSON.stringify(stored), 'utf8');

    assert.throws(() => new AuditChain(chainPath), /integrity/i);
  } finally {
    if (originalKey === undefined) {
      delete process.env.ASGUARD_AUDIT_KEY;
    } else {
      process.env.ASGUARD_AUDIT_KEY = originalKey;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
