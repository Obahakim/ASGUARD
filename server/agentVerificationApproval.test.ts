import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('a flagged decoy agent cannot receive an approval attestation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-decoy-approval-'));
  const previousStateDir = process.env.ASGUARD_STATE_DIR;
  const previousAuditKey = process.env.ASGUARD_AUDIT_KEY;
  process.env.ASGUARD_STATE_DIR = directory;
  process.env.ASGUARD_AUDIT_KEY = 'test-audit-key-12345678901234567890123456789012';
  try {
    const [{ requestSignApproval }, { AgentVerificationStore }] = await Promise.all([
      import('./approvals.js'),
      import('./agentVerification.js'),
    ]);
    const verification = new AgentVerificationStore(path.join(directory, 'verifications.json'));
    verification.set('decoy-agent', 'decoy', 'operator');
    const response = await requestSignApproval({
      agent_id: 'decoy-agent',
      agent_name: 'Potential decoy',
      action: 'swap',
      risk_level: 'low',
      payload_hash: 'a'.repeat(64),
      network: 'near:testnet',
      idempotency_key: 'decoy-check-1',
    }, { id: 'runtime', roles: ['runtime'] }, {} as import('./anomalyEngine').AnomalyEngine, () => {}, verification);

    assert.equal(response.status, 'rejected');
    assert.equal(response.reason, 'agent_flagged_as_decoy');
    assert.match(response.agent_warning ?? '', /flagged as a potential decoy/);
    assert.equal(response.intent_id, undefined);
    assert.equal(response.attestation, undefined);
  } finally {
    if (previousStateDir === undefined) delete process.env.ASGUARD_STATE_DIR;
    else process.env.ASGUARD_STATE_DIR = previousStateDir;
    if (previousAuditKey === undefined) delete process.env.ASGUARD_AUDIT_KEY;
    else process.env.ASGUARD_AUDIT_KEY = previousAuditKey;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
