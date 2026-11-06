import { getAuditSigningKey } from '../server/auditConfig';
import { validateApprovalKeyPair } from '../server/attestationConfig';
import { parseApiCredentials } from '../server/auth';
import { isAllowedApiEndpoint } from '../server/endpointPolicy';
import { nearIntentsDefaults } from '../server/aos/nearIntentsConfig';
import { stripDemoPrivateKeysFromEnvironment } from '../server/demoKeyEnv';
import path from 'node:path';

function validateEndpoint(name: string, value: string): void {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) URL.`);
  }
  if (!isAllowedApiEndpoint(endpoint)) {
    throw new Error(`${name} must use HTTPS except for localhost during local development.`);
  }
}

export function formatStartupError(error: unknown, port = process.env.ASGUARD_PORT || '8080'): string {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ASGUARD_AUDIT_CHAIN_INTEGRITY') {
    const chainPath = 'chainPath' in error && typeof error.chainPath === 'string' ? error.chainPath : 'unknown path';
    return `ASGUARD cannot start: the audit chain at ${chainPath} was signed with a different ASGUARD_AUDIT_KEY.\nFix one of:\n  - restore the original audit key in .env, or\n  - archive the old chain and start fresh: npm run setup -- --reset-state`;
  }
  if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') {
    const errorPort = 'port' in error && (typeof error.port === 'number' || typeof error.port === 'string')
      ? String(error.port) : port;
    return `Port ${errorPort} is already in use. If ASGUARD is already running, stop it with npm run stop; otherwise change ASGUARD_PORT in .env.`;
  }
  return error instanceof Error ? error.message : 'Unknown startup error.';
}

async function start(): Promise<void> {
  stripDemoPrivateKeysFromEnvironment(process.env);
  try {
    parseApiCredentials();
    getAuditSigningKey();
    validateApprovalKeyPair();

    const port = process.env.ASGUARD_PORT || '8080';
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
      throw new Error('ASGUARD_PORT must be an integer from 1 to 65535.');
    }

    const network = process.env.ASGUARD_NEAR_NETWORK || 'testnet';
    if (network !== 'mainnet' && network !== 'testnet') {
      throw new Error('ASGUARD_NEAR_NETWORK must be mainnet or testnet; use testnet for local demos.');
    }
    validateEndpoint('ASGUARD_NEAR_RPC_URL', process.env.ASGUARD_NEAR_RPC_URL || `https://rpc.${network}.near.org`);
    validateEndpoint('ASGUARD_NEAR_INTENTS_API_URL', process.env.ASGUARD_NEAR_INTENTS_API_URL || nearIntentsDefaults(network).apiUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ASGUARD startup] ${message}`);
    if (message.includes('ASGUARD_API_CREDENTIALS')) {
      console.error('[ASGUARD startup] Copy .env.example to .env, replace each token with a different random value of at least 32 bytes, and restart. Generate values with: node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))".');
    } else if (message.includes('ASGUARD_AUDIT_KEY')) {
      console.error('[ASGUARD startup] Set a separate random ASGUARD_AUDIT_KEY of at least 32 bytes in .env, then restart.');
    } else if (message.includes('ASGUARD_ATTESTATION_')) {
      console.error('[ASGUARD startup] Configure a matching Ed25519 private/public key pair; keep the private key server-side only.');
    } else {
      console.error('[ASGUARD startup] Correct the named ASGUARD_* setting in .env and retry.');
    }
    process.exitCode = 1;
    return;
  }

  try {
    await import('../server/index.js');
  } catch (error) {
    const message = formatStartupError(error);
    console.error(message.startsWith('ASGUARD cannot start:') || message.startsWith('Port ')
      ? message : `[ASGUARD startup] ${message}`);
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] || '') === path.resolve(__filename)) void start();
