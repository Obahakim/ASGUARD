import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AuditChain } from '../auditChain';
import { AuditAnchor } from './auditAnchor';

test('audit facade persists structured events and rejects tampered reloads', () => {
  const originalKey = process.env.ASGUARD_AUDIT_KEY;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-anchor-'));
  const chainPath = path.join(directory, 'audit.json');
  process.env.ASGUARD_AUDIT_KEY = 'a-long-enough-test-audit-key-value-123456';
  try {
    const anchor = new AuditAnchor(new AuditChain(chainPath));
    anchor.record('policy_update', { field: 'max_auto_trade_usd', old_value: 100, new_value: 50 });
    const exported = new AuditChain(chainPath).exportChain();
    assert.equal(exported.integrity_verified, true);
    assert.equal(exported.entries[0].event_type, 'policy_update');
    assert.deepEqual(exported.entries[0].payload, { field: 'max_auto_trade_usd', old_value: 100, new_value: 50 });

    const persisted = JSON.parse(fs.readFileSync(chainPath, 'utf8')) as { entries: Array<Record<string, unknown>> };
    persisted.entries[0].payload = { field: 'max_auto_trade_usd', old_value: 1, new_value: 999999 };
    fs.writeFileSync(chainPath, JSON.stringify(persisted), 'utf8');
    assert.throws(() => new AuditChain(chainPath), /integrity/i);
  } finally {
    if (originalKey === undefined) delete process.env.ASGUARD_AUDIT_KEY;
    else process.env.ASGUARD_AUDIT_KEY = originalKey;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});