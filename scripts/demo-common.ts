import { parseApiCredentials } from '../server/auth';

export interface DemoConfig {
  apiUrl: string;
  runtimeToken: string;
  readToken: string;
  auditKey: string;
  network: 'near:testnet';
  verifier: string;
}

const credentialFix = 'Copy .env.example to .env, replace every credential placeholder with a different random value of at least 32 bytes, then restart the backend. Generate values with: node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))".';

export function loadDemoConfig(): DemoConfig {
  let credentials;
  try {
    credentials = parseApiCredentials(process.env.ASGUARD_API_CREDENTIALS);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'invalid credentials';
    throw new Error(`${reason} ${credentialFix}`);
  }

  const runtimeCredentials = credentials.filter((credential) => credential.roles.includes('runtime'));
  const configuredRuntimeToken = process.env.ASGUARD_DEMO_TOKEN?.trim();
  const runtimeCredential = configuredRuntimeToken
    ? runtimeCredentials.find((credential) => credential.token === configuredRuntimeToken)
    : runtimeCredentials[0];
  if (!runtimeCredential) {
    throw new Error(`ASGUARD_DEMO_TOKEN must match a runtime credential in ASGUARD_API_CREDENTIALS, or leave it empty to use the first runtime credential. ${credentialFix}`);
  }

  const readCredential = credentials.find((credential) =>
    credential.roles.some((role) => role === 'admin' || role === 'operator')
  );
  if (!readCredential) {
    throw new Error(`ASGUARD_API_CREDENTIALS must include an admin or operator credential so dashboard HITL decisions can be completed. ${credentialFix}`);
  }

  const auditKey = process.env.ASGUARD_AUDIT_KEY?.trim();
  if (!auditKey || Buffer.byteLength(auditKey, 'utf8') < 32) {
    throw new Error(`ASGUARD_AUDIT_KEY must contain at least 32 bytes for host-side attestation verification. Generate a separate value with: node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))", set it in .env, and restart the backend.`);
  }

  const configuredNetwork = process.env.ASGUARD_NEAR_NETWORK || 'testnet';
  if (configuredNetwork !== 'testnet') {
    throw new Error(`Demos are testnet-only; set ASGUARD_NEAR_NETWORK=testnet in .env and restart the backend. Current value: ${configuredNetwork}.`);
  }

  const configuredUrl = process.env.ASGUARD_API_URL || `http://localhost:${process.env.ASGUARD_PORT || '8080'}`;
  let apiUrl: URL;
  try {
    apiUrl = new URL(configuredUrl);
  } catch {
    throw new Error(`ASGUARD_API_URL must be an HTTP(S) URL. Current value: ${configuredUrl}`);
  }
  if (apiUrl.protocol !== 'https:' && !(apiUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(apiUrl.hostname))) {
    throw new Error('ASGUARD_API_URL must use HTTPS except for localhost during local development.');
  }

  return {
    apiUrl: apiUrl.toString().replace(/\/$/, ''),
    runtimeToken: runtimeCredential.token,
    readToken: readCredential.token,
    auditKey,
    network: 'near:testnet',
    verifier: process.env.ASGUARD_NEAR_INTENTS_VERIFIER || 'intents.near',
  };
}

export async function preflightDemo(config: DemoConfig, command: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${config.apiUrl}/api/policy`, {
      headers: { Authorization: `Bearer ${config.readToken}` },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new Error(`Backend is not reachable at ${config.apiUrl}. Start it with "npm run dev:backend", then retry ${command}.`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(`Backend is reachable at ${config.apiUrl}, but rejected the configured read credential (HTTP ${response.status}). Make sure .env ASGUARD_API_CREDENTIALS matches the running backend, then restart "npm run dev:backend".`);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Backend preflight failed at ${config.apiUrl}/api/policy (HTTP ${response.status})${detail ? `: ${detail}` : ''}. Check the backend log and retry.`);
  }

  console.log(`Preflight: backend reachable and authenticated at ${config.apiUrl}; network=${config.network}; verifier=${config.verifier}.`);
  console.log('Safety: testnet approval-only demo; no wallet, private key, signing, or transaction submission is used.');
}

export async function runDemo(command: string, action: (config: DemoConfig) => Promise<void>): Promise<void> {
  try {
    const config = loadDemoConfig();
    await preflightDemo(config, command);
    await action(config);
  } catch (error) {
    console.error(`[ASGUARD demo] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
