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