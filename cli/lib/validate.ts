import { parseApiCredentials } from '../../server/auth';
import { getAuditSigningKey } from '../../server/auditConfig';
import { validateApprovalKeyPair } from '../../server/attestationConfig';
import { isAllowedApiEndpoint } from '../../server/endpointPolicy';

export function validateEndpoint(name: string, value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) URL.`);
  }
  if (!isAllowedApiEndpoint(endpoint)) {
    throw new Error(`${name} must use HTTPS except for localhost during local development.`);
  }
  return endpoint;
}

export function validateNearAiEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('AI endpoint must be a valid HTTPS URL on near.ai.');
  }
  if (endpoint.protocol !== 'https:' || !(endpoint.hostname === 'near.ai' || endpoint.hostname.endsWith('.near.ai'))) {
    throw new Error('AI endpoint must use HTTPS and a near.ai hostname.');
  }
  return endpoint;
}

export function validatePort(value: string): void {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new Error('ASGUARD_PORT must be an integer from 1 to 65535.');
  }
}

export function validateNetwork(value: string): asserts value is 'mainnet' | 'testnet' {
  if (value !== 'mainnet' && value !== 'testnet') throw new Error('ASGUARD_NEAR_NETWORK must be mainnet or testnet.');
}

export function validateSetupValues(values: {
  credentials: string;
  auditKey: string;
  privatePath: string;
  publicPath: string;
  port: string;
  network: string;
  rpcUrl: string;
  intentsUrl: string;
}): void {
  parseApiCredentials(values.credentials);
  getAuditSigningKey(values.auditKey);
  validateApprovalKeyPair(values.privatePath, values.publicPath);
  validatePort(values.port);
  validateNetwork(values.network);
  validateEndpoint('ASGUARD_NEAR_RPC_URL', values.rpcUrl);
  validateEndpoint('ASGUARD_NEAR_INTENTS_API_URL', values.intentsUrl);
}
