import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityManager, CapabilityName } from './capabilityManager';

test('grants and checks capabilities for the guarded runtime', () => {
  const manager = new CapabilityManager();

  manager.grant('policy_management');
  assert.equal(manager.has('policy_management'), true);
  assert.equal(manager.can('policy_management'), true);

  const denied = manager.can('audit_anchoring', { requireRuntime: true });
  assert.equal(denied, false);

  const allowed = manager.can('policy_management', { requireRuntime: false });
  assert.equal(allowed, true);
});

test('returns the default capability set', () => {
  const manager = new CapabilityManager();
  const caps = manager.list();
  assert.ok(caps.includes('policy_management' as CapabilityName));
  assert.ok(caps.includes('event_monitoring' as CapabilityName));
});
