import { getAuditSigningKey } from '../server/auditConfig';
import { parseApiCredentials } from '../server/auth';

function validateEndpoint(name: string, value: string): void {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) URL.`);
  }
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(endpoint.hostname))) {
    throw new Error(`${name} must use HTTPS except for localhost during local development.`);
  }
}

async function start(): Promise<void> {
  try {
    parseApiCredentials();
    getAuditSigningKey();

    const port = process.env.ASGUARD_PORT || '8080';
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
      throw new Error('ASGUARD_PORT must be an integer from 1 to 65535.');
    }

    const network = process.env.ASGUARD_NEAR_NETWORK || 'testnet';
    if (network !== 'mainnet' && network !== 'testnet') {
      throw new Error('ASGUARD_NEAR_NETWORK must be mainnet or testnet; use testnet for local demos.');
    }
    validateEndpoint('ASGUARD_NEAR_RPC_URL', process.env.ASGUARD_NEAR_RPC_URL || `https://rpc.${network}.near.org`);
    validateEndpoint('ASGUARD_NEAR_INTENTS_API_URL', process.env.ASGUARD_NEAR_INTENTS_API_URL || 'https://1click.chaindefuser.com');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ASGUARD startup] ${message}`);
    if (message.includes('ASGUARD_API_CREDENTIALS')) {
      console.error('[ASGUARD startup] Copy .env.example to .env, replace each token with a different random value of at least 32 bytes, and restart. Generate values with: node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))".');
    } else if (message.includes('ASGUARD_AUDIT_KEY')) {
      console.error('[ASGUARD startup] Set a separate random ASGUARD_AUDIT_KEY of at least 32 bytes in .env, then restart.');
    } else {
      console.error('[ASGUARD startup] Correct the named ASGUARD_* setting in .env and retry.');
    }
    process.exitCode = 1;
    return;
  }

  await import('../server/index.js');
}

void start();
