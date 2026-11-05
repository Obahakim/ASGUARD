import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EnvFile } from './lib/envFile';
import { generateAttestationKeyPair, randomSecretHex } from './lib/generate';
import { parseApiCredentials } from '../server/auth';

const root = process.cwd();
const entry = path.join(root, 'cli', 'setup.ts');

function runSetup(args: string[]) {
  return spawnSync(process.execPath, ['--require', './scripts/test-preload.cjs', '--import', 'tsx', entry, ...args], { cwd: root, encoding: 'utf8', shell: false });
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
    assert.equal(env.getValue('ASGUARD_NEAR_INTENTS_API_URL'), 'https://www.usetidepool.tech');
    assert.equal(env.getValue('ASGUARD_NEAR_INTENTS_VERIFIER'), 'verifier.tidepool-sandbox.testnet');
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
