import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createNearRawEd25519Signer } from '../scripts/nearRawSigner';

const root = process.cwd();
const bootstrapScript = path.join(root, 'scripts', 'ci-bootstrap-env.mjs');
const judgeScript = path.join(root, 'scripts', 'ci-judge-demos.mjs');
const responderScript = path.join(root, 'scripts', 'ci-hitl-responder.mjs');

function runBootstrap(directory: string, onChain: boolean) {
  const envPath = path.join(directory, '.env');
  const keyDirectory = path.join(directory, '.asguard');
  const stateDirectory = path.join(directory, 'state');
  const result = spawnSync(process.execPath, [
    bootstrapScript,
    ...(onChain ? ['--on-chain-demo'] : []),
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ASGUARD_CI_ENV_PATH: envPath,
      ASGUARD_CI_KEY_DIR: keyDirectory,
      ASGUARD_CI_STATE_DIR: stateDirectory,
    },
  });
  return { result, envPath, keyDirectory };
}

function parseEnvFile(filePath: string): Record<string, string> {
  return Object.fromEntries(fs.readFileSync(filePath, 'utf8').split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    return match ? [[match[1], match[2]]] : [];
  }));
}

test('CI bootstrap creates secret-safe approval-only testnet configuration by default', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-ci-bootstrap-'));
  try {
    const { result, envPath, keyDirectory } = runBootstrap(directory, false);
    assert.equal(result.status, 0, result.stderr);
    const env = parseEnvFile(envPath);
    const credentials = JSON.parse(env.ASGUARD_API_CREDENTIALS) as Array<{ token: string }>;
    assert.equal(env.ASGUARD_NEAR_NETWORK, 'testnet');
    assert.equal(env.ASGUARD_NEAR_RPC_URL, 'https://rpc.testnet.fastnear.com');
    assert.equal(env.ASGUARD_DEMO_TIDEPOOL_SETTLE, 'false');
    assert.equal(env.ASGUARD_DEMO_TIDEPOOL_FAUCET, 'false');
    assert.equal(env.ASGUARD_DEMO_TIDEPOOL_ACCOUNT_ID, '');
    assert.equal(env.ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY, '');
    assert.equal(credentials.length, 2);
    assert.notEqual(credentials[0].token, credentials[1].token);
    for (const secret of [...credentials.map((credential) => credential.token), env.ASGUARD_AUDIT_KEY]) {
      assert.equal(result.stdout.includes(secret), false);
      assert.equal(result.stderr.includes(secret), false);
    }
    assert.equal(fs.existsSync(path.join(keyDirectory, 'attestation-private.pem')), true);
    assert.equal(fs.existsSync(path.join(keyDirectory, 'ci-operator-token.txt')), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('CI bootstrap creates a matching ephemeral testnet wallet only when on-chain mode is requested', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-ci-onchain-'));
  try {
    const { result, envPath } = runBootstrap(directory, true);
    assert.equal(result.status, 0, result.stderr);
    const env = parseEnvFile(envPath);
    assert.equal(env.ASGUARD_DEMO_TIDEPOOL_SETTLE, 'true');
    assert.equal(env.ASGUARD_DEMO_TIDEPOOL_FAUCET, 'true');
    assert.equal(createNearRawEd25519Signer(env.ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY).accountId, env.ASGUARD_DEMO_TIDEPOOL_ACCOUNT_ID);
    assert.equal(result.stdout.includes(env.ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('HITL responder rejects an invalid action before attempting network access', () => {
  const result = spawnSync(process.execPath, [responderScript], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ASGUARD_OPERATOR_TOKEN: 'x'.repeat(48),
      HITL_ACTION: 'invalid',
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HITL_ACTION must be allow_once, allow_session, or deny_terminate/);
});

test('judge runner writes a summary artifact when preflight fails', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-ci-logs-'));
  try {
    const result = spawnSync(process.execPath, [judgeScript], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        ASGUARD_CI_ENV_PATH: path.join(directory, 'missing.env'),
        ASGUARD_CI_KEY_DIR: path.join(directory, 'keys'),
        ASGUARD_CI_LOG_DIR: path.join(directory, 'logs'),
      },
    });
    assert.equal(result.status, 1);
    const summaryPath = path.join(directory, 'logs', 'summary.log');
    assert.equal(fs.existsSync(summaryPath), true);
    assert.match(fs.readFileSync(summaryPath, 'utf8'), /FAIL judge_preflight/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
