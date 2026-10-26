import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PolicyStore } from './policyStore';

test('policy mutations advance version and metadata cannot be overwritten', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-policy-test-'));
  const filePath = path.join(directory, 'policy.json');
  try {
    const store = new PolicyStore(filePath);
    const initialVersion = store.getPolicy().version;
    const updated = store.updateField('allowed_assets', ['nep141:wrap.near']);
    assert.notEqual(updated.version, initialVersion);
    assert.deepEqual(updated.allowed_assets, ['nep141:wrap.near']);
    assert.throws(() => store.updateField('version', 'attacker-controlled'), /not mutable/);

    const reloaded = new PolicyStore(filePath);
    assert.equal(reloaded.getPolicy().version, updated.version);
    assert.deepEqual(reloaded.getPolicy().allowed_assets, ['nep141:wrap.near']);
    assert.notEqual(reloaded.reset().version, '1.0.0');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('malformed persisted policy fails startup without replacing the file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-policy-corrupt-'));
  const filePath = path.join(directory, 'policy.json');
  const corruptContents = '{"max_auto_trade_usd":';
  try {
    fs.writeFileSync(filePath, corruptContents, 'utf8');
    assert.throws(() => new PolicyStore(filePath), /JSON|Unexpected end/i);
    assert.equal(fs.readFileSync(filePath, 'utf8'), corruptContents);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('persisted policy with invalid values fails startup', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-policy-invalid-'));
  const filePath = path.join(directory, 'policy.json');
  try {
    fs.writeFileSync(filePath, JSON.stringify({
      max_auto_trade_usd: -1,
      strict_anomaly_detection: true,
      device_ip_lock: true,
      remote_trigger_protection: true,
      active_llm_engine: 'ollama',
    }), 'utf8');
    assert.throws(() => new PolicyStore(filePath), /invalid field values/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('empty retired policy fields are removed while active legacy restrictions fail closed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-policy-legacy-'));
  const filePath = path.join(directory, 'policy.json');
  const basePolicy = {
    max_auto_trade_usd: 100,
    strict_anomaly_detection: true,
    device_ip_lock: true,
    remote_trigger_protection: true,
    active_llm_engine: 'ollama',
    high_risk_bins: [],
    blocked_instrument_fingerprints: [],
  };
  try {
    fs.writeFileSync(filePath, JSON.stringify(basePolicy), 'utf8');
    const store = new PolicyStore(filePath);
    assert.equal('high_risk_bins' in store.getPolicy(), false);

    fs.writeFileSync(filePath, JSON.stringify({ ...basePolicy, blocked_instrument_fingerprints: ['configured'] }), 'utf8');
    assert.throws(() => new PolicyStore(filePath), /manual migration/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});