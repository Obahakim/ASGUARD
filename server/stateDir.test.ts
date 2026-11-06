import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AuditChain, AuditChainIntegrityError } from './auditChain';
import { JsonProfilePersistence } from './profileStore';
import { NearWalletWatchStore } from './nearWalletWatch';
import { PolicyStore } from './policyStore';
import { resolveStatePath } from './stateDir';

function withEnvironment<T>(values: Record<string, string | undefined>, operation: () => T): T {
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return operation();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('state paths prefer store overrides, then state directory, then the legacy home directory', () => {
  const root = path.resolve(__dirname, '..');
  withEnvironment({
    ASGUARD_TEST_STATE_PATH: 'specific.json',
    ASGUARD_STATE_DIR: 'relative-state',
  }, () => {
    assert.equal(resolveStatePath('ignored.json', 'ASGUARD_TEST_STATE_PATH'), 'specific.json');
    assert.equal(resolveStatePath('file.json'), path.join(root, 'relative-state', 'file.json'));
  });
  withEnvironment({ ASGUARD_TEST_STATE_PATH: '', ASGUARD_STATE_DIR: '' }, () => {
    assert.equal(resolveStatePath('file.json', 'ASGUARD_TEST_STATE_PATH'), path.join(os.homedir(), '.asguard', 'file.json'));
  });
});

test('relative state directories resolve from the repository root, not the current directory', () => {
  const root = path.resolve(__dirname, '..');
  const oldDirectory = process.cwd();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-state-cwd-'));
  try {
    process.chdir(directory);
    withEnvironment({ ASGUARD_STATE_DIR: '.asguard/test-state' }, () => {
      assert.equal(resolveStatePath('audit_chain.json'), path.join(root, '.asguard', 'test-state', 'audit_chain.json'));
    });
  } finally {
    process.chdir(oldDirectory);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('audit, profile, wallet, and policy stores use the state directory', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-state-stores-'));
  const stateNames = [
    'ASGUARD_STATE_DIR',
    'ASGUARD_AUDIT_CHAIN_PATH',
    'ASGUARD_AGENT_PROFILES_PATH',
    'ASGUARD_WATCHED_WALLETS_PATH',
    'ASGUARD_POLICY_PATH',
    'ASGUARD_AUDIT_KEY',
  ];
  try {
    withEnvironment(Object.fromEntries(stateNames.map((name) => [name, undefined])), () => {
      process.env.ASGUARD_STATE_DIR = directory;
      process.env.ASGUARD_AUDIT_KEY = 'test-audit-key-that-is-at-least-thirty-two-bytes';

      const chain = new AuditChain();
      chain.addEntry('event-1', 'agent-1', 'action');
      assert.equal(fs.existsSync(path.join(directory, 'audit_chain.json')), true);

      new JsonProfilePersistence().save([]);
      assert.equal(fs.existsSync(path.join(directory, 'agent_profiles.json')), true);

      const watches = new NearWalletWatchStore();
      watches.register({ agent_id: 'agent-1', account_id: 'bot.near', network: 'near:testnet' });
      assert.equal(fs.existsSync(path.join(directory, 'watched_wallets.json')), true);

      const policy = new PolicyStore();
      assert.equal(policy.getPolicyPath(), path.join(directory, 'asguard_policy.json'));
      assert.equal(fs.existsSync(policy.getPolicyPath()), true);
      assert.equal(policy.getPolicy().version, '1.0.0');
    });

    const transactionPath = path.join(directory, 'transaction_intents.json');
    const script = [
      "const store = await import('./server/transactionIntentStore.ts');",
      "store.createTransactionIntent({ idempotency_key: 'state-test', correlation_id: 'state-test', agent_id: 'agent', wallet_id: 'wallet', network: 'near:testnet', action: 'demo', resource: 'demo', payload_hash: 'hash', risk_level: 'low', expires_at: new Date(Date.now() + 60000).toISOString() });",
    ].join('');
    const child = spawnSync(process.execPath, ['--input-type=module', '--import', 'tsx', '-e', script], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      shell: false,
      env: { ...process.env, ASGUARD_TRANSACTION_INTENTS_PATH: transactionPath },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(fs.existsSync(transactionPath), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('store-specific path variables override ASGUARD_STATE_DIR', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-specific-state-'));
  const profilePath = path.join(directory, 'custom-profiles.json');
  const policyPath = path.join(directory, 'custom-policy.json');
  try {
    withEnvironment({
      ASGUARD_STATE_DIR: path.join(directory, 'default'),
      ASGUARD_AGENT_PROFILES_PATH: profilePath,
      ASGUARD_POLICY_PATH: policyPath,
    }, () => {
      new JsonProfilePersistence().save([]);
      assert.equal(fs.existsSync(profilePath), true);
      assert.equal(fs.existsSync(path.join(directory, 'default', 'agent_profiles.json')), false);
      assert.equal(new PolicyStore().getPolicyPath(), policyPath);
      assert.equal(fs.existsSync(policyPath), true);
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('audit chain key mismatch is reported with its typed integrity error', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-audit-key-'));
  const chainPath = path.join(directory, 'audit_chain.json');
  try {
    withEnvironment({ ASGUARD_AUDIT_KEY: 'audit-key-a-012345678901234567890123456789' }, () => {
      new AuditChain(chainPath).addEntry('event-1', 'agent-1', 'action');
    });
    withEnvironment({ ASGUARD_AUDIT_KEY: 'audit-key-b-012345678901234567890123456789' }, () => {
      assert.throws(() => new AuditChain(chainPath), (error: unknown) =>
        error instanceof AuditChainIntegrityError
          && error.code === 'ASGUARD_AUDIT_CHAIN_INTEGRITY'
          && error.chainPath === chainPath);
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
