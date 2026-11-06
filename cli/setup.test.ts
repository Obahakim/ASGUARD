import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EnvFile } from './lib/envFile';
import { generateAttestationKeyPair, randomSecretHex } from './lib/generate';
import { parseApiCredentials } from '../server/auth';
import { AuditChain } from '../server/auditChain';

const root = process.cwd();
const entry = path.join(root, 'cli', 'setup.ts');

function runSetup(args: string[], envOverrides: NodeJS.ProcessEnv = {}) {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-setup-home-'));
  try {
    return spawnSync(process.execPath, ['--require', './scripts/test-preload.cjs', '--import', 'tsx', entry, ...args], {
      cwd: root, encoding: 'utf8', shell: false, env: { ...process.env, ...envOverrides, HOME: testHome, USERPROFILE: testHome },
    });
  } finally {
    fs.rmSync(testHome, { recursive: true, force: true });
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('setup --yes is secret-safe, validates, round-trips Node env-file, and is idempotent', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-setup-'));
  const envPath = path.join(directory, '.env');
  const keys = path.join(directory, '.asguard');
  try {
    const first = runSetup(['--yes', '--env', envPath, '--key-dir', keys]);
    assert.equal(first.status, 0, first.stderr);
    const env = EnvFile.parse(fs.readFileSync(envPath, 'utf8'));
    assert.equal(env.getValue('ASGUARD_NEAR_NETWORK'), 'testnet');
    assert.equal(env.getValue('ASGUARD_STATE_DIR'), '.asguard/state');
    assert.equal(env.getValue('ASGUARD_NEAR_INTENTS_API_URL'), 'https://1click.chaindefuser.com');
    assert.equal(env.getValue('ASGUARD_NEAR_INTENTS_VERIFIER'), 'intents.near');
    assert.equal(env.getValue('ASGUARD_DEMO_TIDEPOOL_SETTLE'), 'false');
    assert.equal(env.getValue('ASGUARD_DEMO_TIDEPOOL_FAUCET'), 'false');
    assert.equal(env.getValue('ASGUARD_DEMO_TIDEPOOL_ACCOUNT_ID') || '', '');
    assert.equal(env.getValue('ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY') || '', '');
    assert.equal(first.stdout.includes('dev stack start requested'), false);
    assert.equal(first.stdout.includes('Open manually:'), false);
    const credentials = JSON.parse(env.getValue('ASGUARD_API_CREDENTIALS') || '') as Array<{ token: string }>;
    const auditKey = env.getValue('ASGUARD_AUDIT_KEY') || '';
    const privateKey = fs.readFileSync(path.join(keys, 'attestation-private.pem'), 'utf8');
    for (const secret of [...credentials.map((credential) => credential.token), auditKey]) {
      assert.equal(first.stdout.includes(secret), false);
      assert.equal(first.stderr.includes(secret), false);
    }
    assert.equal(first.stdout.includes(privateKey), false);
    assert.equal(first.stderr.includes(privateKey), false);
    const dashboardFile = path.join(keys, 'dashboard-token.txt');
    assert.equal(fs.existsSync(dashboardFile), true);
    const dashboardToken = parseApiCredentials(env.getValue('ASGUARD_API_CREDENTIALS')).find((credential) => credential.id === 'dashboard-local')?.token;
    assert.equal(fs.readFileSync(dashboardFile, 'utf8'), dashboardToken);
    assert.equal(first.stdout.includes(dashboardToken || ''), false);
    assert.equal(first.stderr.includes(dashboardToken || ''), false);
    if (process.platform !== 'win32') assert.equal(fs.statSync(dashboardFile).mode & 0o777, 0o600);
    const bytes = fs.readFileSync(envPath);
    const mtime = fs.statSync(envPath).mtimeMs;
    const second = runSetup(['--yes', '--env', envPath, '--key-dir', keys]);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(fs.readFileSync(envPath), bytes);
    assert.equal(fs.statSync(envPath).mtimeMs, mtime);
    assert.equal(fs.readFileSync(dashboardFile, 'utf8'), dashboardToken);
    assert.match(second.stdout, /ASGUARD_API_CREDENTIALS: unchanged/);
    assert.equal(runSetup(['--check', '--env', envPath]).status, 0);

    const loaded = spawnSync(process.execPath, ['--env-file', envPath, '-e',
      'process.stdout.write(JSON.stringify({c:process.env.ASGUARD_API_CREDENTIALS,a:process.env.ASGUARD_AUDIT_KEY}))'],
    { cwd: root, encoding: 'utf8', shell: false });
    assert.equal(loaded.status, 0);
    const parsed = JSON.parse(loaded.stdout) as { c: string; a: string };
    assert.equal(parsed.c, env.getValue('ASGUARD_API_CREDENTIALS'));
    assert.equal(parsed.a, env.getValue('ASGUARD_AUDIT_KEY'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('check fails for placeholders, short tokens, mismatched keypairs, and non-HTTPS RPC', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-invalid-'));
  try {
    const pairA = generateAttestationKeyPair(path.join(directory, 'a'));
    const pairB = generateAttestationKeyPair(path.join(directory, 'b'));
    const contents = (overrides: Record<string, string> = {}) => {
      const env = EnvFile.parse('');
      env.setValue('ASGUARD_API_CREDENTIALS', JSON.stringify([
        { id: 'runtime', token: randomSecretHex(), roles: ['runtime'] },
        { id: 'admin', token: randomSecretHex(), roles: ['admin'] },
      ]));
      env.setValue('ASGUARD_AUDIT_KEY', randomSecretHex());
      env.setValue('ASGUARD_ATTESTATION_PRIVATE_KEY_PATH', pairA.privatePath);
      env.setValue('ASGUARD_ATTESTATION_PUBLIC_KEY_PATH', pairA.publicPath);
      env.setValue('ASGUARD_NEAR_RPC_URL', 'https://rpc.testnet.near.org');
      env.setValue('ASGUARD_PORT', '8080');
      for (const [key, value] of Object.entries(overrides)) env.setValue(key, value);
      return env.serialize();
    };
    const invalidFiles = [
      contents({ ASGUARD_API_CREDENTIALS: 'REPLACE_WITH_CREDENTIALS' }),
      contents({ ASGUARD_API_CREDENTIALS: JSON.stringify([{ id: 'runtime', token: 'short', roles: ['runtime'] }]) }),
      contents({ ASGUARD_ATTESTATION_PUBLIC_KEY_PATH: pairB.publicPath }),
      contents({ ASGUARD_NEAR_RPC_URL: 'http://rpc.example.test' }),
    ];
    for (const text of invalidFiles) {
      const file = path.join(directory, 'invalid.env');
      fs.writeFileSync(file, text);
      assert.equal(runSetup(['--check', '--env', file]).status, 1);
    }
    assert.equal(spawnSync(process.execPath, ['--require', './scripts/test-preload.cjs', '--import', 'tsx', entry], { cwd: root, encoding: 'utf8', shell: false }).status, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('--yes applies official endpoint defaults and never retains a Tidepool demo wallet', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-setup-safe-'));
  const envPath = path.join(directory, '.env');
  try {
    const env = EnvFile.parse('');
    env.setValue('ASGUARD_NEAR_NETWORK', 'testnet');
    env.setValue('ASGUARD_NEAR_RPC_URL', 'https://rpc.mainnet.near.org');
    env.setValue('ASGUARD_NEAR_INTENTS_API_URL', 'https://www.usetidepool.tech');
    env.setValue('ASGUARD_NEAR_INTENTS_VERIFIER', 'verifier.tidepool-sandbox.testnet');
    env.setValue('ASGUARD_DEMO_TIDEPOOL_SETTLE', 'true');
    env.setValue('ASGUARD_DEMO_TIDEPOOL_FAUCET', 'true');
    env.setValue('ASGUARD_DEMO_TIDEPOOL_ACCOUNT_ID', 'f'.repeat(64));
    env.setValue('ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY', 'ed25519:private');
    fs.writeFileSync(envPath, env.serialize());
    const result = runSetup(['--yes', '--env', envPath, '--key-dir', path.join(directory, '.asguard')]);
    assert.equal(result.status, 0, result.stderr);
    const configured = EnvFile.parse(fs.readFileSync(envPath, 'utf8'));
    assert.equal(configured.getValue('ASGUARD_NEAR_RPC_URL'), 'https://rpc.testnet.near.org');
    assert.equal(configured.getValue('ASGUARD_NEAR_INTENTS_API_URL'), 'https://1click.chaindefuser.com');
    assert.equal(configured.getValue('ASGUARD_NEAR_INTENTS_VERIFIER'), 'intents.near');
    assert.equal(configured.getValue('ASGUARD_DEMO_TIDEPOOL_SETTLE'), 'false');
    assert.equal(configured.getValue('ASGUARD_DEMO_TIDEPOOL_FAUCET'), 'false');
    assert.equal(configured.getValue('ASGUARD_DEMO_TIDEPOOL_ACCOUNT_ID') || '', '');
    assert.equal(configured.getValue('ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY') || '', '');
    assert.equal(result.stdout.includes('dev stack start requested'), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('existing valid audit keys keep the legacy location and report the migration option', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-setup-legacy-'));
  const envPath = path.join(directory, '.env');
  const keyDirectory = path.join(directory, '.asguard');
  try {
    assert.equal(runSetup(['--yes', '--env', envPath, '--key-dir', keyDirectory]).status, 0);
    const text = fs.readFileSync(envPath, 'utf8').replace(/^ASGUARD_STATE_DIR=.*\r?\n/m, '');
    fs.writeFileSync(envPath, text);
    const second = runSetup(['--yes', '--env', envPath, '--key-dir', keyDirectory]);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /State is stored in ~\/\.asguard \(legacy location\)\. Run npm run setup -- --reset-state to start fresh in a project-local state directory\./);
    assert.equal(EnvFile.parse(fs.readFileSync(envPath, 'utf8')).getValue('ASGUARD_STATE_DIR'), undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('replacing an invalid audit key archives the chain in its configured state directory', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-setup-rotate-'));
  const envPath = path.join(directory, '.env');
  const keyDirectory = path.join(directory, '.asguard');
  const chainPath = path.join(directory, 'legacy-audit.json');
  try {
    const env = EnvFile.parse('');
    env.setValue('ASGUARD_AUDIT_CHAIN_PATH', chainPath);
    const stateDirectory = path.join(directory, 'state');
    env.setValue('ASGUARD_STATE_DIR', stateDirectory);
    fs.writeFileSync(envPath, env.serialize());
    const initial = runSetup(['--yes', '--env', envPath, '--key-dir', keyDirectory]);
    assert.equal(initial.status, 0, initial.stderr);
    const configured = EnvFile.parse(fs.readFileSync(envPath, 'utf8'));
    const originalKey = configured.getValue('ASGUARD_AUDIT_KEY') || '';
    const originalAuditKey = process.env.ASGUARD_AUDIT_KEY;
    try {
      process.env.ASGUARD_AUDIT_KEY = originalKey;
      new AuditChain(chainPath).addEntry('old-event', 'agent', 'old-chain');
    } finally {
      restoreEnvironment('ASGUARD_AUDIT_KEY', originalAuditKey);
    }

    configured.setValue('ASGUARD_AUDIT_KEY', 'short');
    fs.writeFileSync(envPath, configured.serialize());
    const rotated = runSetup(['--yes', '--env', envPath, '--key-dir', keyDirectory]);
    assert.equal(rotated.status, 0, rotated.stderr);
    const updated = EnvFile.parse(fs.readFileSync(envPath, 'utf8'));
    assert.notEqual(updated.getValue('ASGUARD_AUDIT_KEY'), originalKey);
    assert.equal(updated.getValue('ASGUARD_STATE_DIR'), stateDirectory);
    assert.equal(fs.existsSync(chainPath), false);
    const archives = fs.readdirSync(stateDirectory).filter((name) => name.startsWith('archive-'));
    assert.equal(archives.length, 1);
    const archivedChain = path.join(stateDirectory, archives[0], path.basename(chainPath));
    assert.equal(fs.existsSync(archivedChain), true);
    assert.equal(JSON.parse(fs.readFileSync(archivedChain, 'utf8')).entries[0].event_id, 'old-event');
    if (process.platform !== 'win32') assert.equal(fs.statSync(archivedChain).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('--reset-state archives each configured state file rather than deleting it', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-setup-reset-'));
  const envPath = path.join(directory, '.env');
  const stateDirectory = path.join(directory, 'state');
  const keyDirectory = path.join(directory, '.asguard');
  const fileNames = ['audit_chain.json', 'transaction_intents.json', 'agent_profiles.json', 'watched_wallets.json', 'asguard_policy.json'];
  try {
    const env = EnvFile.parse('');
    env.setValue('ASGUARD_STATE_DIR', stateDirectory);
    fs.mkdirSync(stateDirectory, { recursive: true });
    for (const fileName of fileNames) fs.writeFileSync(path.join(stateDirectory, fileName), `old-${fileName}`);
    fs.writeFileSync(envPath, env.serialize());

    const result = runSetup(['--yes', '--reset-state', '--env', envPath, '--key-dir', keyDirectory]);
    assert.equal(result.status, 0, result.stderr);
    const archiveDirectory = path.join(stateDirectory, fs.readdirSync(stateDirectory).find((name) => name.startsWith('archive-')) || '');
    for (const fileName of fileNames) {
      assert.equal(fs.existsSync(path.join(stateDirectory, fileName)), false);
      assert.equal(fs.readFileSync(path.join(archiveDirectory, fileName), 'utf8'), `old-${fileName}`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('--check reports an audit chain that does not match the configured key', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-setup-check-audit-'));
  const envPath = path.join(directory, '.env');
  const keyDirectory = path.join(directory, '.asguard');
  const chainPath = path.join(directory, 'audit.json');
  try {
    const env = EnvFile.parse('');
    env.setValue('ASGUARD_AUDIT_CHAIN_PATH', chainPath);
    fs.writeFileSync(envPath, env.serialize());
    const generated = runSetup(['--yes', '--env', envPath, '--key-dir', keyDirectory]);
    assert.equal(generated.status, 0, generated.stderr);
    const config = EnvFile.parse(fs.readFileSync(envPath, 'utf8'));
    const originalAuditKey = process.env.ASGUARD_AUDIT_KEY;
    try {
      process.env.ASGUARD_AUDIT_KEY = config.getValue('ASGUARD_AUDIT_KEY') || '';
      new AuditChain(chainPath).addEntry('event-1', 'agent-1', 'action');
    } finally {
      restoreEnvironment('ASGUARD_AUDIT_KEY', originalAuditKey);
    }
    config.setValue('ASGUARD_AUDIT_KEY', 'different-audit-key-that-is-at-least-thirty-two-bytes');
    fs.writeFileSync(envPath, config.serialize());

    const checked = runSetup(['--check', '--env', envPath]);
    assert.equal(checked.status, 1);
    assert.match(checked.stdout, /INFO state directory:/);
    assert.match(checked.stdout, /FAIL audit chain integrity: Audit chain integrity check failed during startup\./);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
