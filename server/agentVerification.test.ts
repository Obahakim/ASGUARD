import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentVerificationStore } from './agentVerification';

test('agent verification defaults to unverified and persists dashboard decisions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-agent-verification-'));
  const filePath = path.join(directory, 'verifications.json');
  try {
    const store = new AgentVerificationStore(filePath);
    assert.deepEqual(store.get('agent-one'), { agent_id: 'agent-one', status: 'unverified' });
    const verified = store.set('agent-one', 'verified', 'operator-1');
    assert.equal(verified.status, 'verified');
    assert.equal(new AgentVerificationStore(filePath).get('agent-one').status, 'verified');

    const decoy = store.set('agent-two', 'decoy', 'operator-2');
    assert.equal(decoy.status, 'decoy');
    assert.deepEqual(new AgentVerificationStore(filePath).list().map(({ agent_id, status }) => ({ agent_id, status })), [
      { agent_id: 'agent-one', status: 'verified' },
      { agent_id: 'agent-two', status: 'decoy' },
    ]);

    store.set('agent-two', 'unverified', 'operator-2');
    assert.equal(new AgentVerificationStore(filePath).get('agent-two').status, 'unverified');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('agent verification rejects malformed IDs and statuses', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-agent-verification-'));
  try {
    const store = new AgentVerificationStore(path.join(directory, 'verifications.json'));
    assert.throws(() => store.set('agent\none', 'verified', 'operator'), /agent_id/);
    assert.throws(() => store.set('agent-one', 'unknown' as never, 'operator'), /status/);
    assert.throws(() => store.set('agent-one', 'verified', ''), /updated_by/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('agent verification rejects a malformed persisted file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-agent-verification-'));
  const filePath = path.join(directory, 'verifications.json');
  try {
    fs.writeFileSync(filePath, JSON.stringify([{ agent_id: 'agent-one', status: 'unknown' }]));
    assert.throws(() => new AgentVerificationStore(filePath), /malformed/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
