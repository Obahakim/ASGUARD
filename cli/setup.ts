import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { createPrompter, type Prompter } from './lib/prompt';
import { parseArgs } from './lib/args';
import { EnvFile, isUnsetValue, readEnvFile, writeEnvFile } from './lib/envFile';
import { generateAttestationKeyPair, randomSecretHex } from './lib/generate';
import { copyToClipboard } from './lib/clipboard';
import { probeNearAi, probeRpc } from './lib/probe';
import { validateEndpoint, validateNearAiEndpoint, validateNetwork, validatePort, validateSetupValues } from './lib/validate';
import { getApprovalPublicKey, validateApprovalKeyPair } from '../server/attestationConfig';
import { parseApiCredentials } from '../server/auth';
import { nearIntentsDefaults, nearRpcDefault } from '../server/aos/nearIntentsConfig';
import { DEFAULT_TESTNET_NEAR_RPC_FAILOVER_URLS, getNearRpcEndpoints } from '../server/aos/nearRpc';
import { generateNearDemoKeyPair, nearDemoKeyMatches } from './lib/nearDemoKey';
import { canOpenBrowser, getStackEndpoints } from './lib/devStack';
import { offerPostSetupActions, openDashboard, startDevStack } from './lib/setupActions';
import { AuditChain } from '../server/auditChain';
import { resolveStatePath } from '../server/stateDir';
import { probeTidepool } from './lib/tidepoolProbe';

const HELP = `ASGUARD server setup

Usage: npm run setup [-- --yes|--check] [--force] [--reset-state] [--advanced] [--on-chain-demo] [--start] [--open] [--env <path>] [--key-dir <path>] [--no-color]
  --yes       Fill missing values using safe testnet defaults without prompting
  --check     Validate the existing configuration without writing
  --force     Regenerate secrets, preserving existing files as backups
  --reset-state Archive existing state files before starting fresh
  --advanced  Open optional endpoint, AI, webhook, and demo settings
  --on-chain-demo  Prepare a Tidepool testnet wallet without prompting
  --start     Start the local development stack after setup
  --open      Start the stack and open the dashboard when available
  --env       Environment file path (default .env)
  --key-dir   Attestation-key directory (default .asguard)
  --no-color  Disable ANSI color
  --help      Show this help
`;
const accountPattern = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;
const stateFiles = [
  ['audit_chain.json', 'ASGUARD_AUDIT_CHAIN_PATH'],
  ['transaction_intents.json', 'ASGUARD_TRANSACTION_INTENTS_PATH'],
  ['agent_profiles.json', 'ASGUARD_AGENT_PROFILES_PATH'],
  ['agent_verifications.json', 'ASGUARD_AGENT_VERIFICATIONS_PATH'],
  ['watched_wallets.json', 'ASGUARD_WATCHED_WALLETS_PATH'],
  ['asguard_policy.json', 'ASGUARD_POLICY_PATH'],
] as const;
const stateEnvironmentNames = ['ASGUARD_STATE_DIR', ...stateFiles.map(([, variable]) => variable), 'ASGUARD_AUDIT_KEY'];
const projectRoot = path.resolve(__dirname, '..');

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown configuration error.';
}

function warnForNearOrgRpc(endpoint: string, log: (message: string) => void): void {
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase();
    if (hostname === 'near.org' || hostname.endsWith('.near.org')) {
      log('Warning: this NEAR RPC uses a near.org endpoint, which may be rate-limited. Consider FastNear or a dedicated RPC provider.');
    }
  } catch {
    return;
  }
}

function masked(value: string): string {
  return `•••• (${Buffer.byteLength(value, 'utf8')} chars)`;
}

function nodeVersionValid(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  return major > 20 || (major === 20 && minor >= 9);
}

function relativePosix(filePath: string, root = process.cwd()): string {
  return path.relative(root, filePath).split(path.sep).join('/') || '.';
}

function keyPaths(directory: string): { privatePath: string; publicPath: string } {
  return {
    privatePath: path.join(directory, 'attestation-private.pem'),
    publicPath: path.join(directory, 'attestation-public.pem'),
  };
}

function backupFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const base = `${filePath}.bak-${Math.floor(Date.now() / 1000)}`;
  let destination = base;
  let suffix = 1;
  while (fs.existsSync(destination)) {
    destination = `${base}-${suffix}`;
    suffix += 1;
  }
  fs.copyFileSync(filePath, destination, fs.constants.COPYFILE_EXCL);
  if (process.platform !== 'win32') fs.chmodSync(destination, 0o600);
  fs.unlinkSync(filePath);
}

function writeDashboardToken(
  filePath: string,
  token: string,
  allowRotate = false,
  log: (message: string) => void = console.log,
): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (fs.existsSync(filePath)) {
    if (fs.readFileSync(filePath, 'utf8') === token) {
      if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
      return filePath;
    }
    if (!allowRotate) throw new Error('dashboard-token.txt already exists with a different token; refusing to overwrite it because setup did not rotate the dashboard credentials.');
    const temporaryPath = path.join(path.dirname(filePath), `.dashboard-token-${process.pid}-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporaryPath, token, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
      if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
    } catch (error) {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
      throw error;
    }
    log('Replaced dashboard-token.txt after rotating the dashboard token.');
    return filePath;
  }
  fs.writeFileSync(filePath, token, { flag: 'wx', mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
  return filePath;
}

function uniqueSecret(used: string[]): string {
  let value = randomSecretHex();
  while (used.includes(value)) value = randomSecretHex();
  return value;
}

function withEnvState<T>(env: EnvFile, operation: () => T): T {
  const previous = new Map(stateEnvironmentNames.map((name) => [name, process.env[name]]));
  for (const name of stateEnvironmentNames) {
    const value = env.getValue(name);
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

function localStateDirectory(): string {
  return path.join(projectRoot, '.asguard', 'state');
}

function stateDirectory(env: EnvFile): string {
  return withEnvState(env, () => path.dirname(resolveStatePath('audit_chain.json')));
}

function archiveFiles(paths: string[], directory: string, now = Date.now()): string[] {
  const existing = [...new Set(paths.filter((filePath) => fs.existsSync(filePath)))];
  if (!existing.length) return [];

  const base = path.join(directory, `archive-${Math.floor(now / 1000)}`);
  let archiveDirectory = base;
  let suffix = 1;
  while (fs.existsSync(archiveDirectory)) {
    archiveDirectory = `${base}-${suffix}`;
    suffix += 1;
  }
  fs.mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(archiveDirectory, 0o700);

  const archived: string[] = [];
  for (const source of existing) {
    const destination = path.join(archiveDirectory, path.basename(source));
    try {
      fs.renameSync(source, destination);
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EXDEV')) throw error;
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      if (fs.readFileSync(source).compare(fs.readFileSync(destination)) !== 0) {
        fs.unlinkSync(destination);
        throw new Error(`Could not verify archived state file ${path.basename(source)}.`);
      }
      fs.unlinkSync(source);
    }
    if (process.platform !== 'win32') fs.chmodSync(destination, 0o600);
    archived.push(destination);
  }
  return archived;
}

function archiveAuditChainForKeyRotation(env: EnvFile, now = Date.now()): void {
  const source = withEnvState(env, () => resolveStatePath('audit_chain.json', 'ASGUARD_AUDIT_CHAIN_PATH'));
  if (!env.getValue('ASGUARD_STATE_DIR')?.trim()) env.setValue('ASGUARD_STATE_DIR', '.asguard/state');
  const destinationDirectory = stateDirectory(env);
  archiveFiles([source], destinationDirectory, now);
}

function archiveAllState(env: EnvFile, now = Date.now()): string[] {
  const sources = withEnvState(env, () => stateFiles.map(([fileName, variable]) => resolveStatePath(fileName, variable)));
  const destinationDirectory = env.getValue('ASGUARD_STATE_DIR')?.trim()
    ? stateDirectory(env)
    : localStateDirectory();
  const archived = archiveFiles(sources, destinationDirectory, now);
  if (!env.getValue('ASGUARD_STATE_DIR')?.trim()) env.setValue('ASGUARD_STATE_DIR', '.asguard/state');
  return archived;
}

function stateIntegrityCheck(env: EnvFile): void {
  const chainPath = withEnvState(env, () => resolveStatePath('audit_chain.json', 'ASGUARD_AUDIT_CHAIN_PATH'));
  if (!fs.existsSync(chainPath)) return;
  withEnvState(env, () => { new AuditChain(chainPath); });
}

function checkItem(name: string, operation: () => void, log: (message: string) => void = console.log): boolean {
  try {
    operation();
    log(`PASS ${name}`);
    return true;
  } catch (error) {
    log(`FAIL ${name}: ${safeError(error)}`);
    return false;
  }
}

function checkConfiguration(envPath: string, log: (message: string) => void = console.log): number {
  const env = readEnvFile(envPath);
  const resolvedStateDirectory = stateDirectory(env);
  log(`INFO state directory: ${resolvedStateDirectory}`);
  const network = env.getValue('ASGUARD_NEAR_NETWORK') || 'testnet';
  const intentsDefaults = nearIntentsDefaults(network === 'mainnet' ? 'mainnet' : 'testnet');
  const values = {
    credentials: env.getValue('ASGUARD_API_CREDENTIALS'),
    auditKey: env.getValue('ASGUARD_AUDIT_KEY'),
    privatePath: env.getValue('ASGUARD_ATTESTATION_PRIVATE_KEY_PATH'),
    publicPath: env.getValue('ASGUARD_ATTESTATION_PUBLIC_KEY_PATH'),
    port: env.getValue('ASGUARD_PORT') || '8080',
    network,
    rpcUrl: env.getValue('ASGUARD_NEAR_RPC_URL') || nearRpcDefault(network === 'mainnet' ? 'mainnet' : 'testnet'),
    rpcFailovers: env.getValue('ASGUARD_NEAR_RPC_FAILOVER_URLS'),
    intentsUrl: env.getValue('ASGUARD_NEAR_INTENTS_API_URL') || intentsDefaults.apiUrl,
  };
  let passed = true;
  const run = (name: string, action: () => void) => { passed = checkItem(name, action, log) && passed; };
  run('API credentials', () => {
    if (isUnsetValue(values.credentials)) throw new Error('missing or placeholder value');
    parseApiCredentials(values.credentials);
  });
  run('audit signing key', () => {
    if (isUnsetValue(values.auditKey) || Buffer.byteLength(values.auditKey || '', 'utf8') < 32) throw new Error('missing, placeholder, or shorter than 32 bytes');
  });
  run('audit chain integrity', () => stateIntegrityCheck(env));
  run('attestation key pair', () => {
    if (isUnsetValue(values.privatePath) || isUnsetValue(values.publicPath)) throw new Error('missing or placeholder key path');
    validateApprovalKeyPair(values.privatePath, values.publicPath);
  });
  run('port', () => validatePort(values.port));
  run('NEAR network', () => validateNetwork(values.network));
  run('NEAR RPC endpoint', () => validateEndpoint('ASGUARD_NEAR_RPC_URL', values.rpcUrl));
  run('NEAR RPC failover endpoints', () => {
    getNearRpcEndpoints(network === 'mainnet' ? 'mainnet' : 'testnet', values.rpcUrl, values.rpcFailovers);
  });
  run('NEAR Intents endpoint', () => validateEndpoint('ASGUARD_NEAR_INTENTS_API_URL', values.intentsUrl));
  warnForNearOrgRpc(values.rpcUrl, log);
  if (passed && values.publicPath) {
    const publicKey = getApprovalPublicKey(values.publicPath);
    const fingerprint = createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest('hex');
    log(`Attestation public-key SHA-256 fingerprint: ${fingerprint}`);
  }
  return passed ? 0 : 1;
}

async function askValid(
  prompter: Prompter,
  question: string,
  validator: (value: string) => string | undefined,
  defaultValue?: string,
): Promise<string> {
  return prompter.ask(question, { validate: validator, ...(defaultValue === undefined ? {} : { default: defaultValue }) });
}

function validateAccount(value: string): boolean {
  return value.length >= 2 && value.length <= 64 && accountPattern.test(value);
}

interface PreparedConfiguration {
  runtimeToken: string;
  dashboardToken: string;
  credentials: string;
  auditKey: string;
  auditChanged: boolean;
  dashboardRotated: boolean;
  privatePath: string;
  publicPath: string;
  keyFiles: { privatePath: string; publicPath: string };
  generateKeys: boolean;
}

function validCredentialsFrom(value: string | undefined): ReturnType<typeof parseApiCredentials> {
  if (isUnsetValue(value)) return [];
  try {
    const parsed: unknown = JSON.parse(value || '');
    if (!Array.isArray(parsed)) return [];
    const credentials: ReturnType<typeof parseApiCredentials> = [];
    const ids = new Set<string>();
    const tokens = new Set<string>();
    for (const candidate of parsed) {
      try {
        const [credential] = parseApiCredentials(JSON.stringify([candidate]));
        if (!credential || ids.has(credential.id) || tokens.has(credential.token)) continue;
        credentials.push(credential);
        ids.add(credential.id);
        tokens.add(credential.token);
      } catch {
        // Keep independently valid credentials when another entry is incomplete.
      }
    }
    return credentials;
  } catch {
    return [];
  }
}

function unusedCredentialId(credentials: ReturnType<typeof parseApiCredentials>, base: string): string {
  let id = base;
  for (let suffix = 1; credentials.some((credential) => credential.id === id); suffix += 1) id = `${base}-${suffix}`;
  return id;
}

function validEndpointOrDefault(name: string, value: string | undefined, fallback: string): string {
  if (!isUnsetValue(value)) {
    try { validateEndpoint(name, value || ''); return value || fallback; } catch { /* use the safe default */ }
  }
  return fallback;
}

function prepareConfiguration(
  env: EnvFile,
  keyDirectory: string,
  projectDirectory: string,
  force = false,
): PreparedConfiguration {
  const rawCredentials = env.getValue('ASGUARD_API_CREDENTIALS');
  const oldCredentials = validCredentialsFrom(rawCredentials);
  let existingCredentialsValid = false;
  if (!isUnsetValue(rawCredentials)) {
    try { parseApiCredentials(rawCredentials); existingCredentialsValid = true; } catch { existingCredentialsValid = false; }
  }
  const oldRuntime = oldCredentials.find((credential) => credential.roles.includes('runtime'))?.token;
  const oldDashboard = oldCredentials.find((credential) =>
    credential.roles.some((role) => ['admin', 'operator', 'auditor'].includes(role)))?.token;
  const credentials = force ? [] : oldCredentials.slice();
  const usedTokens = credentials.map((credential) => credential.token);
  const runtimeToken = force || !oldRuntime ? uniqueSecret(usedTokens) : oldRuntime;
  if (!oldRuntime || force) {
    credentials.push({
      id: unusedCredentialId(credentials, 'runtime-local'),
      token: runtimeToken,
      roles: ['runtime'],
    });
    usedTokens.push(runtimeToken);
  }
  const dashboardToken = force || !oldDashboard ? uniqueSecret(usedTokens) : oldDashboard;
  if (!oldDashboard || force) {
    credentials.push({
      id: unusedCredentialId(credentials, 'dashboard-local'),
      token: dashboardToken,
      roles: ['admin', 'operator', 'auditor'],
    });
  }
  let serializedCredentials = rawCredentials || '';
  if (force || !oldRuntime || !oldDashboard || !existingCredentialsValid) {
    serializedCredentials = JSON.stringify(credentials);
    env.setValue('ASGUARD_API_CREDENTIALS', serializedCredentials);
  }
  const existingAuditKey = env.getValue('ASGUARD_AUDIT_KEY');
  const credentialTokens = credentials.map((credential) => credential.token);
  const auditKey = !force && !isUnsetValue(existingAuditKey)
    && Buffer.byteLength(existingAuditKey || '', 'utf8') >= 32
    && !credentialTokens.includes(existingAuditKey || '')
    ? existingAuditKey || ''
    : uniqueSecret([...credentialTokens]);
  env.setValue('ASGUARD_AUDIT_KEY', auditKey);

  const keyFiles = keyPaths(keyDirectory);
  const configuredPrivate = env.getValue('ASGUARD_ATTESTATION_PRIVATE_KEY_PATH');
  const configuredPublic = env.getValue('ASGUARD_ATTESTATION_PUBLIC_KEY_PATH');
  let privatePath = configuredPrivate ? path.resolve(projectDirectory, configuredPrivate) : '';
  let publicPath = configuredPublic ? path.resolve(projectDirectory, configuredPublic) : '';
  let generateKeys = force || !configuredPrivate || !configuredPublic;
  if (!generateKeys) {
    try { validateApprovalKeyPair(privatePath, publicPath); } catch { generateKeys = true; }
  }
  if (generateKeys) {
    privatePath = keyFiles.privatePath;
    publicPath = keyFiles.publicPath;
    env.setValue('ASGUARD_ATTESTATION_PRIVATE_KEY_PATH', relativePosix(privatePath, projectDirectory));
    env.setValue('ASGUARD_ATTESTATION_PUBLIC_KEY_PATH', relativePosix(publicPath, projectDirectory));
  }

  const currentNetwork = env.getValue('ASGUARD_NEAR_NETWORK');
  let network = currentNetwork || 'testnet';
  try { validateNetwork(network); } catch { network = 'testnet'; }
  env.setValue('ASGUARD_NEAR_NETWORK', network);
  const intentsDefaults = nearIntentsDefaults(network as 'testnet' | 'mainnet');
  const port = env.getValue('ASGUARD_PORT');
  try { validatePort(port || ''); } catch { env.setValue('ASGUARD_PORT', '8080'); }
  if (isUnsetValue(env.getValue('ASGUARD_HOST'))) env.setValue('ASGUARD_HOST', 'localhost');
  if (isUnsetValue(env.getValue('ASGUARD_ALLOWED_ORIGINS'))) env.setValue('ASGUARD_ALLOWED_ORIGINS', 'http://localhost:3000');
  if (isUnsetValue(env.getValue('ASGUARD_API_URL'))) env.setValue('ASGUARD_API_URL', 'http://localhost:8080');
  if (isUnsetValue(env.getValue('NEXT_PUBLIC_ASGUARD_API_URL'))) env.setValue('NEXT_PUBLIC_ASGUARD_API_URL', 'http://localhost:8080');

  const rpcDefault = nearRpcDefault(network as 'testnet' | 'mainnet');
  const currentRpc = env.getValue('ASGUARD_NEAR_RPC_URL');
  const knownRpc = ['https://rpc.testnet.near.org', 'https://rpc.mainnet.near.org', nearRpcDefault('testnet')];
  env.setValue('ASGUARD_NEAR_RPC_URL', !isUnsetValue(currentRpc) && knownRpc.includes(currentRpc || '')
    ? rpcDefault
    : validEndpointOrDefault('ASGUARD_NEAR_RPC_URL', currentRpc, rpcDefault));
  if (isUnsetValue(env.getValue('ASGUARD_NEAR_RPC_FAILOVER_URLS'))) {
    env.setValue('ASGUARD_NEAR_RPC_FAILOVER_URLS', network === 'testnet' ? DEFAULT_TESTNET_NEAR_RPC_FAILOVER_URLS.join(',') : '');
  }
  const intentsUrl = validEndpointOrDefault(
    'ASGUARD_NEAR_INTENTS_API_URL', env.getValue('ASGUARD_NEAR_INTENTS_API_URL'), intentsDefaults.apiUrl,
  );
  env.setValue('ASGUARD_NEAR_INTENTS_API_URL', intentsUrl);
  if (isUnsetValue(env.getValue('ASGUARD_NEAR_INTENTS_VERIFIER'))) {
    env.setValue('ASGUARD_NEAR_INTENTS_VERIFIER', nearIntentsDefaults(
      network as 'testnet' | 'mainnet', intentsUrl === 'https://www.usetidepool.tech',
    ).verifier);
  }
  if (isUnsetValue(env.getValue('ASGUARD_AI_ENABLED'))) env.setValue('ASGUARD_AI_ENABLED', 'false');
  if (isUnsetValue(env.getValue('ASGUARD_DEMO_SUBMIT'))) env.setValue('ASGUARD_DEMO_SUBMIT', 'false');
  return {
    runtimeToken,
    dashboardToken,
    credentials: serializedCredentials,
    auditKey,
    auditChanged: existingAuditKey !== auditKey,
    dashboardRotated: force && oldDashboard !== dashboardToken,
    privatePath,
    publicPath,
    keyFiles,
    generateKeys,
  };
}

function commitConfiguration(
  env: EnvFile,
  envPath: string,
  keyDirectory: string,
  projectDirectory: string,
  prepared: PreparedConfiguration,
  resetState: boolean,
  log: (message: string) => void,
  now = Date.now(),
): void {
  const repository = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: projectDirectory, encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (repository.error || repository.status !== 0) {
    log('Git metadata unavailable; skipped the local-secret ignore check.');
  } else {
    const repositoryRoot = repository.stdout.trim();
    const secretPaths = [
      path.relative(repositoryRoot, envPath),
      path.relative(repositoryRoot, prepared.privatePath),
      path.relative(repositoryRoot, path.join(projectDirectory, '.asguard', 'dashboard-token.txt')),
    ].map((filePath) => filePath.split(path.sep).join('/'));
    const checks = secretPaths.map((filePath) => spawnSync('git', ['check-ignore', '-q', filePath], {
      cwd: repositoryRoot, encoding: 'utf8', shell: false, stdio: 'ignore',
    }));
    if (checks.some((result) => result.error)) {
      log('Could not verify local-secret ignore rules; ensure .env, .asguard/, and *.pem are ignored.');
    } else if (checks.some((result) => result.status !== 0)) {
      log('Warning: one or more local secret paths are not ignored by Git. Add .env, .asguard/, and *.pem to .gitignore.');
    }
  }
  if (prepared.generateKeys) {
    backupFile(prepared.keyFiles.privatePath);
    backupFile(prepared.keyFiles.publicPath);
    generateAttestationKeyPair(keyDirectory);
  }
  if (prepared.auditChanged && !resetState) archiveAuditChainForKeyRotation(env, now);
  validateSetupValues({
    credentials: prepared.credentials,
    auditKey: prepared.auditKey,
    privatePath: prepared.privatePath,
    publicPath: prepared.publicPath,
    port: env.getValue('ASGUARD_PORT') || '8080',
    network: env.getValue('ASGUARD_NEAR_NETWORK') || 'testnet',
    rpcUrl: env.getValue('ASGUARD_NEAR_RPC_URL') || '',
    intentsUrl: env.getValue('ASGUARD_NEAR_INTENTS_API_URL') || '',
  });
  getNearRpcEndpoints(
    env.getValue('ASGUARD_NEAR_NETWORK') === 'mainnet' ? 'mainnet' : 'testnet',
    env.getValue('ASGUARD_NEAR_RPC_URL'),
    env.getValue('ASGUARD_NEAR_RPC_FAILOVER_URLS'),
  );
  warnForNearOrgRpc(env.getValue('ASGUARD_NEAR_RPC_URL') || '', log);
  const changed = writeEnvFile(envPath, env);
  verifyNodeEnvFile(envPath, prepared.credentials, prepared.auditKey);
  const tokenPath = path.join(projectDirectory, '.asguard', 'dashboard-token.txt');
  log(writeDashboardToken(tokenPath, prepared.dashboardToken, prepared.dashboardRotated, log));
  log(changed ? `Wrote ${envPath}` : `${envPath} unchanged.`);
  if (prepared.generateKeys) {
    log(`Attestation keys: ${path.relative(projectDirectory, prepared.keyFiles.privatePath).split(path.sep).join('/')} and ${path.relative(projectDirectory, prepared.keyFiles.publicPath).split(path.sep).join('/')}`);
  }
}

function configurationIsValid(env: EnvFile, projectDirectory: string): boolean {
  try {
    const credentials = parseApiCredentials(env.getValue('ASGUARD_API_CREDENTIALS'));
    if (!credentials.some((credential) => credential.roles.includes('runtime'))
      || !credentials.some((credential) => credential.roles.some((role) => ['admin', 'operator', 'auditor'].includes(role)))) return false;
    const auditKey = env.getValue('ASGUARD_AUDIT_KEY') || '';
    if (Buffer.byteLength(auditKey, 'utf8') < 32 || credentials.some((credential) => credential.token === auditKey)) return false;
    const privatePath = env.getValue('ASGUARD_ATTESTATION_PRIVATE_KEY_PATH') || '';
    const publicPath = env.getValue('ASGUARD_ATTESTATION_PUBLIC_KEY_PATH') || '';
    if (!privatePath || !publicPath) return false;
    validateApprovalKeyPair(path.resolve(projectDirectory, privatePath), path.resolve(projectDirectory, publicPath));
    validatePort(env.getValue('ASGUARD_PORT') || '');
    validateNetwork(env.getValue('ASGUARD_NEAR_NETWORK') || '');
    validateEndpoint('ASGUARD_NEAR_RPC_URL', env.getValue('ASGUARD_NEAR_RPC_URL') || '');
    getNearRpcEndpoints(
      env.getValue('ASGUARD_NEAR_NETWORK') === 'mainnet' ? 'mainnet' : 'testnet',
      env.getValue('ASGUARD_NEAR_RPC_URL'),
      env.getValue('ASGUARD_NEAR_RPC_FAILOVER_URLS'),
    );
    validateEndpoint('ASGUARD_NEAR_INTENTS_API_URL', env.getValue('ASGUARD_NEAR_INTENTS_API_URL') || '');
    for (const name of ['ASGUARD_HOST', 'ASGUARD_ALLOWED_ORIGINS', 'ASGUARD_API_URL', 'NEXT_PUBLIC_ASGUARD_API_URL',
      'ASGUARD_AI_ENABLED', 'ASGUARD_DEMO_SUBMIT']) {
      if (isUnsetValue(env.getValue(name))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function tidepoolWalletConfigured(env: EnvFile): boolean {
  const accountId = env.getValue('ASGUARD_DEMO_TIDEPOOL_ACCOUNT_ID') || '';
  const privateKey = env.getValue('ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY') || '';
  return env.getValue('ASGUARD_NEAR_NETWORK') === 'testnet'
    && env.getValue('ASGUARD_DEMO_TIDEPOOL_SETTLE') === 'true'
    && nearDemoKeyMatches(privateKey, accountId);
}

function enableTidepoolWallet(env: EnvFile, log: (message: string) => void, rotate = false): void {
  const currentAccount = env.getValue('ASGUARD_DEMO_TIDEPOOL_ACCOUNT_ID') || '';
  const currentKey = env.getValue('ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY') || '';
  const pair = !rotate && nearDemoKeyMatches(currentKey, currentAccount)
    ? { accountId: currentAccount, privateKey: currentKey }
    : generateNearDemoKeyPair();
  env.setValue('ASGUARD_DEMO_TIDEPOOL_ACCOUNT_ID', pair.accountId);
  env.setValue('ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY', pair.privateKey);
  env.setValue('ASGUARD_DEMO_TIDEPOOL_SETTLE', 'true');
  env.setValue('ASGUARD_DEMO_TIDEPOOL_FAUCET', 'true');
  const defaults = nearIntentsDefaults('testnet', true);
  env.setValue('ASGUARD_NEAR_INTENTS_API_URL', defaults.apiUrl);
  env.setValue('ASGUARD_NEAR_INTENTS_VERIFIER', defaults.verifier);
  log('WARNING: Tidepool settlement is testnet only. The key stays in local .env; the backend strips it from its process at startup. Never commit .env or use a mainnet key.');
}

function disableTidepoolWallet(env: EnvFile, tidepoolQuotes = false): void {
  const network = env.getValue('ASGUARD_NEAR_NETWORK') || 'testnet';
  const defaults = nearIntentsDefaults(network === 'mainnet' ? 'mainnet' : 'testnet', tidepoolQuotes && network === 'testnet');
  env.setValue('ASGUARD_NEAR_INTENTS_API_URL', defaults.apiUrl);
  env.setValue('ASGUARD_NEAR_INTENTS_VERIFIER', defaults.verifier);
  env.setValue('ASGUARD_DEMO_TIDEPOOL_SETTLE', 'false');
  env.setValue('ASGUARD_DEMO_TIDEPOOL_FAUCET', 'false');
  env.setValue('ASGUARD_DEMO_TIDEPOOL_ACCOUNT_ID', '');
  env.setValue('ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY', '');
}

async function promptForTidepoolWallet(
  env: EnvFile,
  prompter: Prompter,
  fetchImpl: typeof fetch,
  log: (message: string) => void,
  rotate = false,
): Promise<void> {
  const probe = await probeTidepool(fetchImpl);
  if (probe.available) {
    log('Tidepool testnet: reachable.');
  } else {
    log(`Tidepool testnet: not reachable right now (${probe.reason || 'could not reach the service'}).`);
  }
  const question = probe.available
    ? 'Enable the on-chain demo wallet? ASGUARD creates a local, testnet-only wallet so demo:onchain can settle a real testnet swap.'
    : 'The on-chain demo needs Tidepool, which is down at the moment. Prepare the demo wallet anyway so demo:onchain works when it is back?';
  if (await prompter.confirm(question, true)) enableTidepoolWallet(env, log, rotate);
  else disableTidepoolWallet(env);
}

async function configureAdvanced(
  env: EnvFile,
  prompter: Prompter,
  prepared: PreparedConfiguration,
  keyDirectory: string,
  projectDirectory: string,
  noColor: boolean,
  fetchImpl: typeof fetch,
  log: (message: string) => void,
  forceRequested = false,
): Promise<{ prepared: PreparedConfiguration; status: number }> {
  log('Current secret delivery: dashboard token saved to .asguard/dashboard-token.txt; clipboard copying is off.');
  if (await prompter.confirm('Copy a secret to the clipboard?', false)) {
    const choices = ['dashboard token', 'runtime token'];
    const tidepoolConfigured = nearDemoKeyMatches(
      env.getValue('ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY') || '',
      env.getValue('ASGUARD_DEMO_TIDEPOOL_ACCOUNT_ID') || '',
    );
    if (tidepoolConfigured) choices.push('Tidepool account ID');
    const selected = await prompter.choose('Select value to copy:', choices, { defaultIndex: 0 });
    const value = selected === 'dashboard token' ? prepared.dashboardToken
      : selected === 'runtime token' ? prepared.runtimeToken
        : env.getValue('ASGUARD_DEMO_TIDEPOOL_ACCOUNT_ID') || '';
    log(copyToClipboard(value) ? 'Copied.' : 'Clipboard unavailable.');
  }

  const currentNetwork = env.getValue('ASGUARD_NEAR_NETWORK') || 'testnet';
  log(`Current network: ${currentNetwork}; RPC: ${env.getValue('ASGUARD_NEAR_RPC_URL') || '(default)'}; failovers: ${env.getValue('ASGUARD_NEAR_RPC_FAILOVER_URLS') || '(none)'}; Intents API: ${env.getValue('ASGUARD_NEAR_INTENTS_API_URL') || '(default)'}.`);
  if (await prompter.confirm('Configure network and endpoints?', false)) {
    const networkChoice = await prompter.choose('NEAR network:', ['testnet', 'mainnet'], { defaultIndex: currentNetwork === 'mainnet' ? 1 : 0 });
    if (networkChoice === 'mainnet') {
      await prompter.confirmTyped('Type mainnet to confirm', 'mainnet');
      env.setValue('ASGUARD_NEAR_NETWORK', 'mainnet');
      disableTidepoolWallet(env);
    } else env.setValue('ASGUARD_NEAR_NETWORK', 'testnet');
    const network = env.getValue('ASGUARD_NEAR_NETWORK') || 'testnet';
    const defaults = nearIntentsDefaults(network as 'testnet' | 'mainnet');
    const rpc = await prompter.ask('ASGUARD_NEAR_RPC_URL', {
      default: env.getValue('ASGUARD_NEAR_RPC_URL') || nearRpcDefault(network as 'testnet' | 'mainnet'),
      validate: (value) => {
        try { validateEndpoint('ASGUARD_NEAR_RPC_URL', value); return undefined; } catch (error) { return safeError(error); }
      },
    });
    const intentsUrl = await prompter.ask('ASGUARD_NEAR_INTENTS_API_URL', {
      default: env.getValue('ASGUARD_NEAR_INTENTS_API_URL') || defaults.apiUrl,
      validate: (value) => {
        try { validateEndpoint('ASGUARD_NEAR_INTENTS_API_URL', value); return undefined; } catch (error) { return safeError(error); }
      },
    });
    const rpcFailovers = await prompter.ask('ASGUARD_NEAR_RPC_FAILOVER_URLS', {
      default: env.getValue('ASGUARD_NEAR_RPC_FAILOVER_URLS') || '',
      validate: (value) => {
        try { getNearRpcEndpoints(network as 'testnet' | 'mainnet', rpc, value); return undefined; }
        catch (error) { return safeError(error); }
      },
    });
    env.setValue('ASGUARD_NEAR_RPC_URL', rpc);
    env.setValue('ASGUARD_NEAR_RPC_FAILOVER_URLS', rpcFailovers);
    env.setValue('ASGUARD_NEAR_INTENTS_API_URL', intentsUrl);
    env.setValue('ASGUARD_NEAR_INTENTS_VERIFIER', nearIntentsDefaults(
      network as 'testnet' | 'mainnet', intentsUrl === 'https://www.usetidepool.tech',
    ).verifier);
    try { log(`NEAR RPC: ${await probeRpc(rpc, fetchImpl)}`); } catch { log('NEAR RPC: unreachable (continuing)'); }
  }

  log(`Current ports and origins: host=${env.getValue('ASGUARD_HOST') || 'localhost'}, port=${env.getValue('ASGUARD_PORT') || '8080'}, origins=${env.getValue('ASGUARD_ALLOWED_ORIGINS') || 'http://localhost:3000'}.`);
  if (await prompter.confirm('Configure ports and origins?', false)) {
    env.setValue('ASGUARD_HOST', await prompter.ask('ASGUARD_HOST', { default: env.getValue('ASGUARD_HOST') || 'localhost' }));
    env.setValue('ASGUARD_PORT', await askValid(prompter, 'ASGUARD_PORT', (value) => {
      try { validatePort(value); return undefined; } catch (error) { return safeError(error); }
    }, env.getValue('ASGUARD_PORT') || '8080'));
    for (const [name, fallback] of [
      ['ASGUARD_ALLOWED_ORIGINS', 'http://localhost:3000'],
      ['ASGUARD_API_URL', 'http://localhost:8080'],
      ['NEXT_PUBLIC_ASGUARD_API_URL', 'http://localhost:8080'],
    ]) env.setValue(name, await prompter.ask(name, { default: env.getValue(name) || fallback }));
  }

  log(`Current NEAR AI advisory: ${env.getValue('ASGUARD_AI_ENABLED') === 'true' ? env.getValue('ASGUARD_AI_PROVIDER') || 'enabled' : 'off'}.`);
  if (await prompter.confirm('Configure NEAR AI advisory (annotate-only)?', false)) {
    env.setValue('ASGUARD_AI_ENABLED', 'true');
    const mode = await prompter.choose('AI provider:', ['heuristic (no key needed)', 'live NEAR AI Cloud'], { defaultIndex: 0 });
    if (mode.startsWith('heuristic')) {
      env.setValue('ASGUARD_AI_PROVIDER', 'heuristic');
      env.setValue('ASGUARD_AI_API_URL', '');
      env.setValue('ASGUARD_AI_API_KEY', '');
      env.setValue('ASGUARD_AI_MODEL', '');
    } else {
      const endpoint = await prompter.ask('Full chat-completions URL', {
        default: env.getValue('ASGUARD_AI_API_URL') || '',
        validate: (value) => {
          try { validateNearAiEndpoint(value); return undefined; } catch (error) { return safeError(error); }
        },
      });
      const apiKey = await prompter.askSecret('NEAR AI API key');
      const model = await prompter.ask('Model name', { default: env.getValue('ASGUARD_AI_MODEL') || '' });
      const result = await probeNearAi({ endpoint, model, apiKey, fetchImpl });
      if (!result.ok && !await prompter.confirm('Save anyway?', false)) return { prepared, status: 1 };
      env.setValue('ASGUARD_AI_PROVIDER', 'near-ai');
      env.setValue('ASGUARD_AI_API_URL', endpoint);
      env.setValue('ASGUARD_AI_API_KEY', apiKey);
      env.setValue('ASGUARD_AI_MODEL', model);
    }
  }

  log('Current webhook alert URLs are hidden.');
  if (await prompter.confirm('Configure webhook alerts?', false)) {
    for (const name of ['TELEGRAM_WEBHOOK_URL', 'SLACK_WEBHOOK_URL', 'DISCORD_WEBHOOK_URL', 'ASGUARD_GENERIC_WEBHOOK_URL']) {
      const value = await prompter.askSecret(`${name} (leave empty to skip)`, {
        validate: (candidate) => {
          if (!candidate) return undefined;
          try { return new URL(candidate).protocol === 'https:' ? undefined : 'Webhook URL must use HTTPS.'; }
          catch { return 'Webhook URL must use HTTPS.'; }
        },
      });
      if (value) env.setValue(name, value);
    }
  }

  log(`Current host-signed testnet transfer demo: ${env.getValue('ASGUARD_DEMO_SUBMIT') === 'true' ? 'enabled' : 'disabled'}.`);
  if (await prompter.confirm('Configure host-signed NEAR transfer demo?', false)) {
    if ((env.getValue('ASGUARD_NEAR_NETWORK') || 'testnet') !== 'testnet') {
      log('The submit demo is testnet-only; it remains disabled.');
      env.setValue('ASGUARD_DEMO_SUBMIT', 'false');
    } else {
      const warning = 'WARNING: testnet only; maximum 0.01 NEAR; private key stored in local .env and deleted from the backend process at startup.';
      log(noColor ? warning : `\u001b[1m${warning}\u001b[0m`);
      const sender = await askValid(prompter, 'ASGUARD_DEMO_NEAR_ACCOUNT_ID', (value) => validateAccount(value) ? undefined : 'Invalid account ID.',
        env.getValue('ASGUARD_DEMO_NEAR_ACCOUNT_ID'));
      const recipient = await askValid(prompter, 'ASGUARD_DEMO_NEAR_RECIPIENT', (value) => validateAccount(value) ? undefined : 'Invalid account ID.',
        env.getValue('ASGUARD_DEMO_NEAR_RECIPIENT'));
      const amount = await askValid(prompter, 'ASGUARD_DEMO_NEAR_AMOUNT', (value) => {
        const parts = value.split('.');
        if (parts.length > 2 || !/^\d+$/.test(parts[0] || '') || (parts[1] !== undefined && !/^\d{1,24}$/.test(parts[1]))) {
          return 'Use a positive decimal with at most 24 fractional digits.';
        }
        const yocto = BigInt(`${parts[0]}${(parts[1] || '').padEnd(24, '0')}`);
        return yocto > 0n && yocto <= 10n ** 22n ? undefined : 'Amount must be greater than zero and at most 0.01 NEAR.';
      }, env.getValue('ASGUARD_DEMO_NEAR_AMOUNT') || '0.001');
      const privateKey = await prompter.askSecret('Private key (ed25519:...) or press Enter to fill later', {
        validate: (value) => !value || value.startsWith('ed25519:') ? undefined : 'Private key must start with ed25519:.',
      });
      env.setValue('ASGUARD_DEMO_NEAR_ACCOUNT_ID', sender);
      env.setValue('ASGUARD_DEMO_NEAR_RECIPIENT', recipient);
      env.setValue('ASGUARD_DEMO_NEAR_AMOUNT', amount);
      if (privateKey) env.setValue('ASGUARD_DEMO_NEAR_PRIVATE_KEY', privateKey);
      env.setValue('ASGUARD_DEMO_SUBMIT', privateKey ? 'true' : 'false');
    }
  }

  let nextPrepared = prepared;
  log('Rotating these values replaces local credentials and archives the audit chain.');
  if (forceRequested || await prompter.confirm('Rotate secrets or keys?', false)) {
    await prompter.confirmTyped('Type regenerate to rotate secrets and keys', 'regenerate');
    nextPrepared = prepareConfiguration(env, keyDirectory, projectDirectory, true);
  }
  return { prepared: nextPrepared, status: 0 };
}

function setupSummary(env: EnvFile, prepared: PreparedConfiguration): string[] {
  const rows: Array<[string, string]> = [
    ['ASGUARD_API_CREDENTIALS', `runtime + dashboard credentials (${prepared.credentials.length} chars)`],
    ['ASGUARD_AUDIT_KEY', masked(prepared.auditKey)],
    ['ASGUARD_ATTESTATION_PRIVATE_KEY_PATH', env.getValue('ASGUARD_ATTESTATION_PRIVATE_KEY_PATH') || '(missing)'],
    ['ASGUARD_ATTESTATION_PUBLIC_KEY_PATH', env.getValue('ASGUARD_ATTESTATION_PUBLIC_KEY_PATH') || '(missing)'],
    ['ASGUARD_NEAR_NETWORK', env.getValue('ASGUARD_NEAR_NETWORK') || 'testnet'],
    ['ASGUARD_NEAR_RPC_URL', masked(env.getValue('ASGUARD_NEAR_RPC_URL') || '')],
    ['ASGUARD_NEAR_INTENTS_API_URL', masked(env.getValue('ASGUARD_NEAR_INTENTS_API_URL') || '')],
    ['ASGUARD_DEMO_TIDEPOOL_ACCOUNT_ID', env.getValue('ASGUARD_DEMO_TIDEPOOL_ACCOUNT_ID') ? '(configured)' : '(empty)'],
  ];
  return rows.map(([name, value]) => `${name.padEnd(40)} ${value}`);
}

async function startOnRequest(
  options: SetupRunOptions,
  log: (message: string) => void,
  openRequested: boolean,
  env: EnvFile,
  keyDirectory: string,
  projectRoot: string,
  fetchImpl: typeof fetch,
  showToken: boolean,
): Promise<boolean> {
  if (!options.startStack || !await options.startStack()) {
    log('The dev stack did not become ready. See .asguard/dev.log; stop it with npm run stop or run npm run dev manually.');
    return false;
  }
  await logReadyScreen(env, keyDirectory, projectRoot, showToken, fetchImpl, log);
  if (openRequested) {
    if (!options.isTTY || !canOpenBrowser()) {
      log('No interactive graphical browser is available. Open manually: http://localhost:3000');
    } else if (!await (options.openBrowser || openDashboard)()) {
      log('Could not open a browser. Open manually: http://localhost:3000');
    }
  }
  return true;
}

async function logReadyScreen(
  env: EnvFile,
  keyDirectory: string,
  projectRoot: string,
  interactiveTTY: boolean,
  fetchImpl: typeof fetch,
  log: (message: string) => void,
): Promise<void> {
  const { backendUrl, frontendUrl: dashboardUrl } = getStackEndpoints(projectRoot);
  log('ASGUARD dev stack is ready.');
  log(`Backend: ${backendUrl}`);
  log(`Dashboard: ${dashboardUrl}`);
  const tokenPath = path.join(keyDirectory, 'dashboard-token.txt');
  const token = interactiveTTY && fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, 'utf8').trim() : '';
  log(token ? `Dashboard token: ${token}` : `Dashboard token: ${relativePosix(tokenPath, projectRoot)} (available only in a local terminal).`);
  log('Stop the dev stack with: npm run stop');
  log('Demo commands: npm run demo:near:approve, npm run demo:near:hitl');
  const probe = await probeTidepool(fetchImpl);
  if (probe.available) {
    log(tidepoolWalletConfigured(env)
      ? 'Tidepool testnet is reachable. On-chain demo: npm run demo:onchain'
      : 'Tidepool testnet is reachable. Prepare its testnet wallet with: npm run setup -- --on-chain-demo');
  } else {
    log(`Tidepool testnet is currently unavailable (${probe.reason || 'health check failed'}); its on-chain demo may not run.`);
  }
}

function verifyNodeEnvFile(filePath: string, credentials: string, auditKey: string): void {
  const result = spawnSync(process.execPath, [
    '--env-file', filePath, '-e',
    'process.stdout.write(JSON.stringify({c:process.env.ASGUARD_API_CREDENTIALS,a:process.env.ASGUARD_AUDIT_KEY}))',
  ], { encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) throw new Error('Node could not load the written environment file.');
  const parsed = JSON.parse(result.stdout) as { c?: string; a?: string };
  if (parsed.c !== credentials || parsed.a !== auditKey) throw new Error('Written environment file failed the Node --env-file round trip.');
}

export interface SetupRunOptions {
  argv: string[];
  input: Readable & { isTTY?: boolean; setRawMode?: (enabled: boolean) => void };
  output: Writable;
  isTTY: boolean;
  fetchImpl?: typeof fetch;
  startStack?: () => Promise<boolean>;
  openBrowser?: () => Promise<boolean>;
  now?: () => number;
  projectRoot?: string;
}

export async function runSetup(options: SetupRunOptions): Promise<number> {
  const log = (message: string) => options.output.write(`${message}\n`);
  const now = options.now?.() ?? Date.now();
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(options.argv, ['env', 'key-dir'], [
      'yes', 'check', 'force', 'reset-state', 'no-color', 'help', 'advanced', 'on-chain-demo', 'start', 'open',
    ]);
    if (args.positionals.length) throw new Error(`Unexpected argument: ${args.positionals[0]}`);
    if (args.flags.has('yes') && args.flags.has('check')) throw new Error('--yes and --check cannot be combined.');
    if (args.flags.has('check') && args.flags.has('reset-state')) throw new Error('--check and --reset-state cannot be combined.');
    if (args.flags.has('on-chain-demo') && args.flags.has('check')) throw new Error('--on-chain-demo cannot be combined with --check.');
    if (args.flags.has('yes') && args.flags.has('advanced')) throw new Error('--advanced requires interactive setup and cannot be combined with --yes.');
    if (args.flags.has('check') && ['force', 'advanced', 'on-chain-demo', 'start', 'open'].some((flag) => args.flags.has(flag))) {
      throw new Error('--check cannot be combined with setup or startup options.');
    }
  } catch (error) {
    log(`[ASGUARD setup] ${safeError(error)}\n${HELP}`);
    return 2;
  }

  if (args.flags.has('help')) { log(HELP.trimEnd()); return 0; }
  if (!nodeVersionValid()) { log('[ASGUARD setup] Requires Node.js 20.9.0 or later.'); return 1; }

  const projectDirectory = path.resolve(options.projectRoot || process.cwd());
  const envPath = path.resolve(projectDirectory, args.values.get('env') || '.env');
  const keyDirectory = path.resolve(projectDirectory, args.values.get('key-dir') || '.asguard');
  const fetchImpl = options.fetchImpl || fetch;
  if (args.flags.has('check')) {
    try { return checkConfiguration(envPath, log); } catch (error) { log(`[ASGUARD setup] ${safeError(error)}`); return 1; }
  }
  if (!args.flags.has('yes') && !options.isTTY) {
    log('[ASGUARD setup] Interactive setup requires a TTY; use --yes for safe defaults or --check to validate.');
    return 2;
  }

  let env: EnvFile;
  try { env = readEnvFile(envPath); } catch (error) {
    log(`[ASGUARD setup] ${safeError(error)}`);
    return 1;
  }
  const existingConfigurationIsValid = fs.existsSync(envPath) && configurationIsValid(env, projectDirectory);
  const keysToReport = [
    'ASGUARD_API_CREDENTIALS', 'ASGUARD_AUDIT_KEY', 'ASGUARD_ATTESTATION_PRIVATE_KEY_PATH',
    'ASGUARD_ATTESTATION_PUBLIC_KEY_PATH', 'ASGUARD_NEAR_NETWORK', 'ASGUARD_PORT',
    'ASGUARD_NEAR_RPC_URL', 'ASGUARD_NEAR_RPC_FAILOVER_URLS',
    'ASGUARD_NEAR_INTENTS_API_URL', 'ASGUARD_NEAR_INTENTS_VERIFIER',
    'ASGUARD_AI_ENABLED', 'ASGUARD_DEMO_SUBMIT', 'ASGUARD_DEMO_TIDEPOOL_SETTLE', 'ASGUARD_DEMO_TIDEPOOL_FAUCET',
  ];
  const before = new Map(keysToReport.map((key) => [key, env.getValue(key)]));

  try {
    const auditKey = env.getValue('ASGUARD_AUDIT_KEY') || '';
    const auditKeyValid = Buffer.byteLength(auditKey, 'utf8') >= 32
      && !validCredentialsFrom(env.getValue('ASGUARD_API_CREDENTIALS')).some((credential) => credential.token === auditKey);
    if (!args.flags.has('reset-state') && !args.flags.has('force') && auditKeyValid) {
      try { stateIntegrityCheck(env); } catch (error) {
        log(`[ASGUARD setup] ${safeError(error)} Run npm run setup -- --reset-state to archive the incompatible state.`);
        return 1;
      }
    }

    if (args.flags.has('yes')) {
      const archived = args.flags.has('reset-state') ? archiveAllState(env, now) : [];
      const originalAudit = env.getValue('ASGUARD_AUDIT_KEY');
      const prepared = prepareConfiguration(env, keyDirectory, projectDirectory, args.flags.has('force'));
      if (args.flags.has('on-chain-demo')) {
        if (env.getValue('ASGUARD_NEAR_NETWORK') !== 'testnet') {
          throw new Error('--on-chain-demo is available only on testnet.');
        }
        const probe = await probeTidepool(fetchImpl);
        log(probe.available ? 'Tidepool testnet: reachable.' : `Tidepool testnet: not reachable right now (${probe.reason || 'could not reach the service'}); preparing the demo wallet anyway.`);
        enableTidepoolWallet(env, log, args.flags.has('force'));
      } else {
        disableTidepoolWallet(env, env.getValue('ASGUARD_NEAR_NETWORK') === 'testnet');
      }
      if (!args.flags.has('reset-state') && !env.getValue('ASGUARD_STATE_DIR')?.trim()
        && !isUnsetValue(originalAudit) && Buffer.byteLength(originalAudit || '', 'utf8') >= 32
        && !prepared.auditChanged) {
        log('State is stored in ~/.asguard (legacy location). Run npm run setup -- --reset-state to start fresh in a project-local state directory.');
      }
      commitConfiguration(env, envPath, keyDirectory, projectDirectory, prepared, args.flags.has('reset-state'), log, now);
      for (const key of keysToReport) {
        const status = before.get(key) === env.getValue(key) ? 'unchanged' : before.get(key) === undefined ? 'generated' : 'set';
        log(`${key}: ${status}`);
      }
      log(`Attestation key pair: ${prepared.generateKeys ? 'generated' : 'kept'}`);
      if (archived.length) log(`Archived state files:\n${archived.join('\n')}`);
      log('Setup complete.');
      if (args.flags.has('start') || args.flags.has('open')) {
        if (!await startOnRequest(options, log, args.flags.has('open'), env, keyDirectory, projectDirectory, fetchImpl,
          options.isTTY && !args.flags.has('yes'))) return 1;
      } else {
        log('Start later with: npm run dev');
      }
      return 0;
    }

    const prompter = createPrompter({
      input: options.input, output: options.output, isTTY: options.isTTY, noColor: args.flags.has('no-color'),
    });
    if (fs.existsSync(envPath)) {
      log(existingConfigurationIsValid
        ? 'Existing configuration is valid; preserving configured values.'
        : 'Existing configuration has gaps; preserving valid values and filling missing settings.');
    }

    let archived: string[] = [];
    if (args.flags.has('reset-state')) {
      await prompter.confirmTyped('Type reset to archive existing state', 'reset');
      archived = archiveAllState(env, now);
    }
    let prepared = prepareConfiguration(env, keyDirectory, projectDirectory);
    if (args.flags.has('force')) {
      await prompter.confirmTyped('Type regenerate to replace secrets and keys', 'regenerate');
      prepared = prepareConfiguration(env, keyDirectory, projectDirectory, true);
    }
    if (args.flags.has('on-chain-demo') && env.getValue('ASGUARD_NEAR_NETWORK') !== 'testnet') {
      throw new Error('--on-chain-demo is available only on testnet.');
    }
    if (env.getValue('ASGUARD_NEAR_NETWORK') === 'testnet' && !tidepoolWalletConfigured(env)) {
      if (args.flags.has('on-chain-demo')) {
        const probe = await probeTidepool(fetchImpl);
        log(probe.available ? 'Tidepool testnet: reachable.' : `Tidepool testnet: not reachable right now (${probe.reason || 'could not reach the service'}); preparing the demo wallet anyway.`);
        enableTidepoolWallet(env, log, args.flags.has('force'));
      } else {
        await promptForTidepoolWallet(env, prompter, fetchImpl, log, args.flags.has('force'));
      }
    } else if (env.getValue('ASGUARD_NEAR_NETWORK') !== 'testnet') {
      disableTidepoolWallet(env);
    }

    if (args.flags.has('advanced') || await prompter.confirm('Configure advanced options?', false)) {
      const result = await configureAdvanced(
        env, prompter, prepared, keyDirectory, projectDirectory, args.flags.has('no-color'), fetchImpl, log,
      );
      if (result.status !== 0) return result.status;
      prepared = result.prepared;
    }
    log(setupSummary(env, prepared).join('\n'));
    if (prepared.auditChanged && !args.flags.has('reset-state')
      && !env.getValue('ASGUARD_STATE_DIR')?.trim()
      && !isUnsetValue(before.get('ASGUARD_AUDIT_KEY'))) {
      log('State is stored in ~/.asguard (legacy location). Run npm run setup -- --reset-state to start fresh in a project-local state directory.');
    }
    commitConfiguration(env, envPath, keyDirectory, projectDirectory, prepared, args.flags.has('reset-state'), log, now);
    if (archived.length) log(`Archived state files:\n${archived.join('\n')}`);
    log('Setup complete.');
    if (args.flags.has('start') || args.flags.has('open')) {
      if (!await startOnRequest(options, log, args.flags.has('open'), env, keyDirectory, projectDirectory, fetchImpl,
        options.isTTY)) return 1;
    } else {
      await offerPostSetupActions({
        interactiveTTY: options.isTTY,
        yes: false,
        check: false,
        prompter,
        log,
        startDevStack: options.startStack || (async () => false),
        openDashboard: options.openBrowser || (async () => false),
        onReady: () => logReadyScreen(env, keyDirectory, projectDirectory, options.isTTY, fetchImpl, log),
      });
    }
    return 0;
  } catch (error) {
    const code = error && typeof error === 'object' && 'exitCode' in error ? Number(error.exitCode) : 1;
    if (code !== 130) log(`[ASGUARD setup] ${safeError(error)}`);
    return code === 130 ? 130 : 1;
  }
}

if (require.main === module) {
  const input = process.stdin as Readable & { isTTY?: boolean; setRawMode?: (enabled: boolean) => void };
  void runSetup({
    argv: process.argv.slice(2),
    input,
    output: process.stdout,
    isTTY: Boolean(process.stdin.isTTY),
    startStack: startDevStack,
    openBrowser: openDashboard,
  }).then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    console.error(`[ASGUARD setup] ${safeError(error)}`);
    process.exitCode = 1;
  });
}
