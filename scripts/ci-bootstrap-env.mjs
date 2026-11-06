import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TIDEPOOL_URL = 'https://www.usetidepool.tech';
const TIDEPOOL_VERIFIER = 'verifier.tidepool-sandbox.testnet';
const RPC_FAILOVERS = 'https://rpc.testnet.near.org,https://near-testnet.drpc.org,https://neart.lava.build';
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function encodeBase58(bytes) {
  let number = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
  let result = '';
  while (number > 0n) {
    const remainder = Number(number % 58n);
    result = ALPHABET[remainder] + result;
    number /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    result = `1${result}`;
  }
  return result || '1';
}

function generateNearDemoKeyPair() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const privateDer = Buffer.from(pair.privateKey.export({ format: 'der', type: 'pkcs8' }));
  const publicDer = Buffer.from(pair.publicKey.export({ format: 'der', type: 'spki' }));
  const publicBytes = publicDer.subarray(-32);
  return {
    accountId: publicBytes.toString('hex'),
    privateKey: `ed25519:${encodeBase58(Buffer.concat([privateDer.subarray(-32), publicBytes]))}`,
  };
}

function writePrivateFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, data, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
  if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
}

function envLine(name, value) {
  if (/[\r\n]/.test(value)) throw new Error(`Refusing to write a newline in ${name}.`);
  return `${name}=${value}`;
}

function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--on-chain-demo') || args.filter((arg) => arg === '--on-chain-demo').length > 1) {
    throw new Error('Usage: node scripts/ci-bootstrap-env.mjs [--on-chain-demo].');
  }
  const onChain = args.includes('--on-chain-demo');
  const envPath = path.resolve(process.env.ASGUARD_CI_ENV_PATH || path.join(root, '.env.ci'));
  const keyDirectory = path.resolve(process.env.ASGUARD_CI_KEY_DIR || path.join(root, '.asguard-ci'));
  const defaultStateRoot = process.env.RUNNER_TEMP
    ? path.join(process.env.RUNNER_TEMP, 'asguard-state')
    : path.join(os.tmpdir(), `asguard-state-${process.pid}-${crypto.randomUUID()}`);
  const stateDirectory = path.resolve(process.env.ASGUARD_CI_STATE_DIR || defaultStateRoot);

  fs.mkdirSync(keyDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const runtimeToken = crypto.randomBytes(32).toString('hex');
  const operatorToken = crypto.randomBytes(32).toString('hex');
  const auditKey = crypto.randomBytes(32).toString('hex');
  const credentials = JSON.stringify([
    { id: 'runtime-ci', token: runtimeToken, roles: ['runtime'] },
    { id: 'operator-ci', token: operatorToken, roles: ['admin', 'operator', 'auditor'] },
  ]);
  const attestation = crypto.generateKeyPairSync('ed25519');
  const privatePath = path.join(keyDirectory, 'attestation-private.pem');
  const publicPath = path.join(keyDirectory, 'attestation-public.pem');
  writePrivateFile(privatePath, attestation.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  writePrivateFile(publicPath, attestation.publicKey.export({ format: 'pem', type: 'spki' }));
  const operatorTokenPath = path.join(keyDirectory, 'ci-operator-token.txt');
  writePrivateFile(operatorTokenPath, `${operatorToken}\n`);

  const tidepoolPair = onChain ? generateNearDemoKeyPair() : undefined;
  const relativeFromRoot = (value) => path.relative(root, value).split(path.sep).join('/') || '.';
  const entries = [
    ['ASGUARD_API_CREDENTIALS', credentials],
    ['ASGUARD_AUDIT_KEY', auditKey],
    ['ASGUARD_ATTESTATION_PRIVATE_KEY_PATH', relativeFromRoot(privatePath)],
    ['ASGUARD_ATTESTATION_PUBLIC_KEY_PATH', relativeFromRoot(publicPath)],
    ['ASGUARD_HOST', '127.0.0.1'],
    ['ASGUARD_PORT', '8080'],
    ['ASGUARD_API_URL', 'http://127.0.0.1:8080'],
    ['NEXT_PUBLIC_ASGUARD_API_URL', 'http://127.0.0.1:8080'],
    ['ASGUARD_RUNTIME', 'asguard'],
    ['ASGUARD_ALLOWED_ORIGINS', 'http://127.0.0.1:3000'],
    ['ASGUARD_STATE_DIR', stateDirectory],
    ['ASGUARD_AUDIT_CHAIN_PATH', path.join(stateDirectory, 'audit_chain.json')],
    ['ASGUARD_TRANSACTION_INTENTS_PATH', path.join(stateDirectory, 'transaction_intents.json')],
    ['ASGUARD_AGENT_PROFILES_PATH', path.join(stateDirectory, 'agent_profiles.json')],
    ['ASGUARD_AGENT_VERIFICATIONS_PATH', path.join(stateDirectory, 'agent_verifications.json')],
    ['ASGUARD_WATCHED_WALLETS_PATH', path.join(stateDirectory, 'watched_wallets.json')],
    ['ASGUARD_POLICY_PATH', path.join(stateDirectory, 'asguard_policy.json')],
    ['ASGUARD_AI_ENABLED', 'false'],
    ['ASGUARD_DEMO_SUBMIT', 'false'],
    ['ASGUARD_NEAR_NETWORK', 'testnet'],
    ['ASGUARD_NEAR_RPC_URL', 'https://rpc.testnet.fastnear.com'],
    ['ASGUARD_NEAR_RPC_FAILOVER_URLS', RPC_FAILOVERS],
    ['ASGUARD_NEAR_INTENTS_API_URL', TIDEPOOL_URL],
    ['ASGUARD_NEAR_INTENTS_VERIFIER', TIDEPOOL_VERIFIER],
    ['ASGUARD_NEAR_CHAIN_SIGNATURES_CONTRACT', 'v1.signer-prod.testnet'],
    ['ASGUARD_DEMO_TIDEPOOL_SETTLE', String(onChain)],
    ['ASGUARD_DEMO_TIDEPOOL_FAUCET', String(onChain)],
    ['ASGUARD_DEMO_TIDEPOOL_ACCOUNT_ID', tidepoolPair?.accountId || ''],
    ['ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY', tidepoolPair?.privateKey || ''],
  ];

  fs.mkdirSync(path.dirname(envPath), { recursive: true, mode: 0o700 });
  writePrivateFile(envPath, `${entries.map(([name, value]) => envLine(name, value)).join('\n')}\n`);
  process.stdout.write(`ENV_FILE=${envPath}\nOPERATOR_TOKEN_FILE=${operatorTokenPath}\n`);
  if (tidepoolPair) process.stdout.write(`TIDEPOOL_ACCOUNT_ID=${tidepoolPair.accountId}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`[ASGUARD CI bootstrap] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
