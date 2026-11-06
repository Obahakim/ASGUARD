import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
import { generateNearDemoKeyPair, nearDemoKeyMatches } from './lib/nearDemoKey';
import { offerPostSetupActions } from './lib/setupActions';

const HELP = `ASGUARD server setup

Usage: npm run setup [-- --yes|--check] [--force] [--env <path>] [--key-dir <path>] [--no-color]
  --yes       Fill missing values using safe testnet defaults without prompting
  --check     Validate the existing configuration without writing
  --force     Regenerate secrets, preserving existing files as backups
  --env       Environment file path (default .env)
  --key-dir   Attestation-key directory (default .asguard)
  --no-color  Disable ANSI color
  --help      Show this help
`;
const accountPattern = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;
type Status = 'generated' | 'kept' | 'set' | 'skipped' | 'unchanged';

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown configuration error.';
}

function masked(value: string): string {
  return `•••• (${Buffer.byteLength(value, 'utf8')} chars)`;
}

function nodeVersionValid(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  return major > 20 || (major === 20 && minor >= 9);
}

function relativePosix(filePath: string): string {
  return path.relative(process.cwd(), filePath).split(path.sep).join('/') || '.';
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

function writeDashboardToken(filePath: string, token: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (fs.existsSync(filePath)) {
    if (fs.readFileSync(filePath, 'utf8') !== token) throw new Error('dashboard-token.txt already exists with a different token; remove it before rotating the dashboard token.');
    return filePath;
  }
  fs.writeFileSync(filePath, token, { flag: 'wx', mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
  return filePath;
}

function credentialsByRole(value: string | undefined): { runtime?: string; dashboard?: string } {
  if (isUnsetValue(value)) return {};
  try {
    const credentials = parseApiCredentials(value);
    return {
      runtime: credentials.find((credential) => credential.roles.includes('runtime'))?.token,
      dashboard: credentials.find((credential) => credential.roles.includes('admin'))?.token,
    };
  } catch {
    return {};
  }
}

function uniqueSecret(used: string[]): string {
  let value = randomSecretHex();
  while (used.includes(value)) value = randomSecretHex();
  return value;
}

function checkItem(name: string, operation: () => void): boolean {
  try {
    operation();
    console.log(`PASS ${name}`);
    return true;
  } catch (error) {
    console.log(`FAIL ${name}: ${safeError(error)}`);
    return false;
  }
}

function checkConfiguration(envPath: string): number {
  const env = readEnvFile(envPath);
  const network = env.getValue('ASGUARD_NEAR_NETWORK') || 'testnet';
  const intentsDefaults = nearIntentsDefaults(network === 'mainnet' ? 'mainnet' : 'testnet');
  const values = {
    credentials: env.getValue('ASGUARD_API_CREDENTIALS'),
    auditKey: env.getValue('ASGUARD_AUDIT_KEY'),
    privatePath: env.getValue('ASGUARD_ATTESTATION_PRIVATE_KEY_PATH'),
    publicPath: env.getValue('ASGUARD_ATTESTATION_PUBLIC_KEY_PATH'),
    port: env.getValue('ASGUARD_PORT') || '8080',
    network,
    rpcUrl: env.getValue('ASGUARD_NEAR_RPC_URL') || `https://rpc.${network}.near.org`,
    intentsUrl: env.getValue('ASGUARD_NEAR_INTENTS_API_URL') || intentsDefaults.apiUrl,
  };
  let passed = true;
  const run = (name: string, action: () => void) => { passed = checkItem(name, action) && passed; };
  run('API credentials', () => {
    if (isUnsetValue(values.credentials)) throw new Error('missing or placeholder value');
    parseApiCredentials(values.credentials);
  });
  run('audit signing key', () => {
    if (isUnsetValue(values.auditKey) || Buffer.byteLength(values.auditKey || '', 'utf8') < 32) throw new Error('missing, placeholder, or shorter than 32 bytes');
  });
  run('attestation key pair', () => {
    if (isUnsetValue(values.privatePath) || isUnsetValue(values.publicPath)) throw new Error('missing or placeholder key path');
    validateApprovalKeyPair(values.privatePath, values.publicPath);
  });
  run('port', () => validatePort(values.port));
  run('NEAR network', () => validateNetwork(values.network));
  run('NEAR RPC endpoint', () => validateEndpoint('ASGUARD_NEAR_RPC_URL', values.rpcUrl));
  run('NEAR Intents endpoint', () => validateEndpoint('ASGUARD_NEAR_INTENTS_API_URL', values.intentsUrl));
  if (passed && values.publicPath) {
    const publicKey = getApprovalPublicKey(values.publicPath);
    const fingerprint = createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest('hex');
    console.log(`Attestation public-key SHA-256 fingerprint: ${fingerprint}`);
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

async function collectSecret(
  prompter: Prompter,
  label: string,
  existing: string | undefined,
  prior: string[],
): Promise<{ value: string; status: Status }> {
  if (existing && !prior.includes(existing) && await prompter.confirm(`Keep existing ${label}?`, true)) {
    return { value: existing, status: 'kept' };
  }
  let value: string;
  if (await prompter.confirm(`Generate ${label}?`, true)) value = randomSecretHex();
  else {
    console.log('In another terminal run: node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))"');
    value = await prompter.askSecret('Paste the result', {
      validate: (candidate) => Buffer.byteLength(candidate, 'utf8') < 32 ? 'Secret must be at least 32 bytes.' : undefined,
    });
  }
  if (Buffer.byteLength(value, 'utf8') < 32 || prior.includes(value)) {
    console.log('Secrets must be at least 32 bytes and distinct.');
    return collectSecret(prompter, label, undefined, prior);
  }
  return { value, status: 'generated' };
}

function secretOutput(
  prompter: Prompter,
  label: string,
  token: string,
  tokenFile?: string,
): Promise<() => void> {
  const choices = tokenFile ? '[c]opy, [f]ile, or [n]one' : '[c]opy to clipboard or [n]one';
  return prompter.ask(
    `For ${label}, choose ${choices}`,
    {
      default: 'n',
      validate: (value) => (tokenFile ? ['c', 'f', 'n'] : ['c', 'n']).includes(value.toLowerCase()) ? undefined : 'Choose an available option.',
    },
  ).then((answer) => () => {
    const choice = answer.toLowerCase();
    if (choice === 'c') console.log(copyToClipboard(token) ? 'Copied.' : 'Clipboard unavailable.');
    if (choice === 'f' && tokenFile) console.log(writeDashboardToken(tokenFile, token));
  });
}

function validateAccount(value: string): boolean {
  return value.length >= 2 && value.length <= 64 && accountPattern.test(value);
}

async function configureOptional(env: EnvFile, prompter: Prompter, network: string, noColor: boolean, regenerate: boolean): Promise<number> {
  if (await prompter.confirm('Configure optional ports and origins?', false)) {
    env.setValue('ASGUARD_HOST', await prompter.ask('ASGUARD_HOST', { default: env.getValue('ASGUARD_HOST') || 'localhost' }));
    env.setValue('ASGUARD_PORT', await askValid(prompter, 'ASGUARD_PORT', (value) => {
      try { validatePort(value); return undefined; } catch (error) { return safeError(error); }
    }, env.getValue('ASGUARD_PORT') || '8080'));
    for (const [key, fallback] of [
      ['ASGUARD_ALLOWED_ORIGINS', 'http://localhost:3000'],
      ['ASGUARD_API_URL', 'http://localhost:8080'],
      ['NEXT_PUBLIC_ASGUARD_API_URL', 'http://localhost:8080'],
    ]) env.setValue(key, await prompter.ask(key, { default: env.getValue(key) || fallback }));
  }

  if (await prompter.confirm('Configure AI advisory (annotate-only)?', false)) {
    env.setValue('ASGUARD_AI_ENABLED', 'true');
    const mode = await prompter.choose('AI provider:', ['heuristic (no key needed)', 'live NEAR AI Cloud'], { defaultIndex: 0 });
    if (mode.startsWith('heuristic')) {
      env.setValue('ASGUARD_AI_PROVIDER', 'heuristic');
      env.setValue('ASGUARD_AI_API_URL', '');
      env.setValue('ASGUARD_AI_API_KEY', '');
      env.setValue('ASGUARD_AI_MODEL', '');
    } else {
      console.log('Get a key at https://cloud.near.ai. Verify endpoint details at https://docs.near.ai.');
      const endpoint = await prompter.ask('Full chat-completions URL', { validate: (value) => {
        try { validateNearAiEndpoint(value); return undefined; } catch (error) { return safeError(error); }
      } });
      const apiKey = await prompter.askSecret('NEAR AI API key');
      let models: string[] = [];
      try {
        const modelsUrl = endpoint.replace(/\/chat\/completions\/?$/, '/models');
        const response = await fetch(modelsUrl, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(5_000) });
        if (response.ok) {
          const body = await response.json() as { data?: Array<{ id?: unknown }> };
          models = (body.data || []).flatMap((model) => typeof model.id === 'string' ? [model.id] : []).slice(0, 10);
        }
      } catch { models = []; }
      if (models.length) console.log(`Available models: ${models.join(', ')}`);
      else console.log('Could not list provider models; enter the model name manually.');
      const model = await prompter.ask('Model name', models[0] ? { default: models[0] } : {});
      const result = await probeNearAi({ endpoint, model, apiKey });
      if (result.ok) console.log(`NEAR AI reachable: ${model}`);
      else {
        console.log(`NEAR AI test failed${result.status ? ` (HTTP ${result.status})` : ''}. ${result.reason || ''}`);
        if (!await prompter.confirm('Save anyway?', false)) return 1;
      }
      env.setValue('ASGUARD_AI_PROVIDER', 'near-ai');
      env.setValue('ASGUARD_AI_API_URL', endpoint);
      env.setValue('ASGUARD_AI_API_KEY', apiKey);
      env.setValue('ASGUARD_AI_MODEL', model);
    }
  }

  if (await prompter.confirm('Configure a public wallet-watch demo account?', false)) {
    let account = '';
    try {
      account = await prompter.ask('ASGUARD_WATCH_DEMO_ACCOUNT (leave empty to skip)', {
        validate: (value) => !value || validateAccount(value) ? undefined : 'Enter a valid public NEAR account ID, or leave empty to skip.',
      });
    } catch (error) {
      if (safeError(error) !== 'Too many invalid responses.') throw error;
      console.log('Skipping wallet-watch demo account after invalid entries.');
    }
    if (account) env.setValue('ASGUARD_WATCH_DEMO_ACCOUNT', account);
    else console.log('Skipping wallet-watch demo account.');
  }

  if (await prompter.confirm('Configure webhook alerts?', false)) {
    for (const name of ['TELEGRAM_WEBHOOK_URL', 'SLACK_WEBHOOK_URL', 'DISCORD_WEBHOOK_URL', 'ASGUARD_GENERIC_WEBHOOK_URL']) {
      const value = await prompter.askSecret(`${name} (leave empty to skip)`, { validate: (candidate) => {
        if (!candidate) return undefined;
        try { return new URL(candidate).protocol === 'https:' ? undefined : 'Webhook URL must use HTTPS.'; }
        catch { return 'Webhook URL must use HTTPS.'; }
      } });
      if (value) env.setValue(name, value);
    }
  }

  if (await prompter.confirm('Enable testnet submit demo? Testnet only, at most 0.01 NEAR; the backend deletes the key from its process at startup.', false)) {
    if (network !== 'testnet') {
      console.log('The submit demo is testnet-only; it remains disabled.');
      env.setValue('ASGUARD_DEMO_SUBMIT', 'false');
    } else {
      const warning = 'WARNING: testnet only; maximum 0.01 NEAR; private key stored in local .env and deleted from the backend process at startup.';
      console.log(noColor || process.env.NO_COLOR !== undefined ? warning : `\u001b[1m${warning}\u001b[0m`);
      console.log('For creating a testnet account, see https://docs.near.org/.');
      const sender = await askValid(prompter, 'ASGUARD_DEMO_NEAR_ACCOUNT_ID', (value) => validateAccount(value) ? undefined : 'Invalid account ID.');
      const recipient = await askValid(prompter, 'ASGUARD_DEMO_NEAR_RECIPIENT', (value) => validateAccount(value) ? undefined : 'Invalid account ID.');
      const amount = await askValid(prompter, 'ASGUARD_DEMO_NEAR_AMOUNT', (value) => {
        const parts = value.split('.');
        if (parts.length > 2 || !/^\d+$/.test(parts[0] || '') || (parts[1] !== undefined && !/^\d{1,24}$/.test(parts[1]))) {
          return 'Use a positive decimal with at most 24 fractional digits.';
        }
        const yocto = BigInt(`${parts[0]}${(parts[1] || '').padEnd(24, '0')}`);
        return yocto > 0n && yocto <= 10n ** 22n ? undefined : 'Amount must be greater than zero and at most 0.01 NEAR.';
      }, '0.001');
      const privateKey = await prompter.askSecret('Private key (ed25519:...) or press Enter to fill later', {
        validate: (value) => !value || value.startsWith('ed25519:') ? undefined : 'Private key must start with ed25519:.',
      });
      env.setValue('ASGUARD_DEMO_NEAR_ACCOUNT_ID', sender);
      env.setValue('ASGUARD_DEMO_NEAR_RECIPIENT', recipient);
      env.setValue('ASGUARD_DEMO_NEAR_AMOUNT', amount);
      if (privateKey) env.setValue('ASGUARD_DEMO_NEAR_PRIVATE_KEY', privateKey);
      else console.log('Fill ASGUARD_DEMO_NEAR_PRIVATE_KEY in .env later; the submit demo will remain disabled.');
      env.setValue('ASGUARD_DEMO_SUBMIT', privateKey ? 'true' : 'false');
    }
  } else env.setValue('ASGUARD_DEMO_SUBMIT', 'false');

  if (network === 'testnet') {
    const enableTidepool = await prompter.confirm('Create a local Tidepool on-chain demo testnet keypair and enable optional settlement?', false);
    if (!enableTidepool) {
      const defaults = nearIntentsDefaults('testnet');
      env.setValue('ASGUARD_NEAR_INTENTS_API_URL', defaults.apiUrl);
      env.setValue('ASGUARD_NEAR_INTENTS_VERIFIER', defaults.verifier);
      env.setValue('ASGUARD_DEMO_TIDEPOOL_SETTLE', 'false');
      env.setValue('ASGUARD_DEMO_TIDEPOOL_FAUCET', 'false');
      env.setValue('ASGUARD_DEMO_TIDEPOOL_ACCOUNT_ID', '');
      env.setValue('ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY', '');
    } else {
      const currentKey = env.getValue('ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY') || '';
      const currentAccount = env.getValue('ASGUARD_DEMO_TIDEPOOL_ACCOUNT_ID') || '';
      const existingValid = nearDemoKeyMatches(currentKey, currentAccount);
      let rotate = !existingValid;
      if (existingValid && regenerate) {
        rotate = await prompter.confirm('Rotate the existing Tidepool demo keypair?', false);
      }
      const pair = rotate ? generateNearDemoKeyPair() : { accountId: currentAccount, privateKey: currentKey };
      env.setValue('ASGUARD_DEMO_TIDEPOOL_ACCOUNT_ID', pair.accountId);
      env.setValue('ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY', pair.privateKey);
      env.setValue('ASGUARD_DEMO_TIDEPOOL_SETTLE', 'true');
      env.setValue('ASGUARD_DEMO_TIDEPOOL_FAUCET', 'true');
      const defaults = nearIntentsDefaults('testnet', true);
      env.setValue('ASGUARD_NEAR_INTENTS_API_URL', defaults.apiUrl);
      env.setValue('ASGUARD_NEAR_INTENTS_VERIFIER', defaults.verifier);
      const warning = 'WARNING: Tidepool settlement is testnet only. The key stays in local .env; the backend strips it from its process at startup. Never commit .env or use a mainnet key.';
      console.log(noColor || process.env.NO_COLOR !== undefined ? warning : `\u001b[1m${warning}\u001b[0m`);
      try {
        const response = await fetch('https://www.usetidepool.tech/v0/health', { signal: AbortSignal.timeout(5_000) });
        if (!response.ok) console.log(`Tidepool health probe returned HTTP ${response.status}; setup will continue.`);
      } catch { console.log('Tidepool health probe unavailable; setup will continue.'); }
      if (await prompter.confirm('Copy Tidepool account ID to clipboard?', true)) {
        console.log(copyToClipboard(pair.accountId) ? 'Account ID copied.' : 'Clipboard unavailable.');
      }
      if (await prompter.confirm('Copy the Tidepool private key to clipboard? It is sensitive.', false)) {
        console.log(copyToClipboard(pair.privateKey) ? 'Private key copied.' : 'Clipboard unavailable.');
      }
    }
  } else {
    const defaults = nearIntentsDefaults('mainnet');
    env.setValue('ASGUARD_NEAR_INTENTS_API_URL', defaults.apiUrl);
    env.setValue('ASGUARD_NEAR_INTENTS_VERIFIER', defaults.verifier);
    env.setValue('ASGUARD_DEMO_TIDEPOOL_SETTLE', 'false');
    env.setValue('ASGUARD_DEMO_TIDEPOOL_FAUCET', 'false');
    env.setValue('ASGUARD_DEMO_TIDEPOOL_ACCOUNT_ID', '');
    env.setValue('ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY', '');
  }
  return 0;
}

async function interactive(env: EnvFile, envPath: string, keyDirectory: string, force: boolean, noColor: boolean): Promise<number> {
  const prompter = createPrompter({ input: process.stdin, output: process.stdout, isTTY: Boolean(process.stdin.isTTY), noColor });
  let regenerate = force;
  if (fs.existsSync(envPath)) {
    console.log(`Existing environment file detected: ${envPath}`);
    if (force) await prompter.confirmTyped('Type regenerate to replace secrets', 'regenerate');
    else {
      const choice = await prompter.choose('Configuration mode:', ['keep valid values and fill only gaps', 'regenerate secrets'], { defaultIndex: 0 });
      if (choice === 'regenerate secrets') {
        regenerate = true;
        await prompter.confirmTyped('Type regenerate to replace secrets', 'regenerate');
      }
    }
  }

  const keyFiles = keyPaths(keyDirectory);
  const ignorePaths = [envPath, path.join(keyDirectory, 'x.pem')].map((value) =>
    path.relative(process.cwd(), value).split(path.sep).join('/'));
  const ignoreResults = ignorePaths.map((value) => spawnSync('git', ['check-ignore', '-q', value], { shell: false, stdio: 'ignore' }));
  if (ignoreResults.some((result) => result.error)) console.log('Git is unavailable; skipped the ignore check.');
  else if (ignoreResults.some((result) => result.status !== 0)) {
    console.log('Warning: one or more paths are not ignored by Git.');
    if (await prompter.confirm('Show .gitignore entries to add?', true)) {
      console.log('.env\n.asguard/\n*.pem');
      console.log('This wizard does not edit .gitignore; add these entries before committing local configuration.');
    }
  }

  console.log('Runtime token authorizes agent API requests; dashboard token signs in operators; audit key protects audit records.');
  const current = credentialsByRole(env.getValue('ASGUARD_API_CREDENTIALS'));
  const secrets: string[] = [];
  const runtime = await collectSecret(prompter, 'runtime token', regenerate ? undefined : current.runtime, secrets);
  secrets.push(runtime.value);
  const dashboard = await collectSecret(prompter, 'dashboard token', regenerate ? undefined : current.dashboard, secrets);
  secrets.push(dashboard.value);
  const oldAudit = regenerate || isUnsetValue(env.getValue('ASGUARD_AUDIT_KEY')) ? undefined : env.getValue('ASGUARD_AUDIT_KEY');
  const audit = await collectSecret(prompter, 'audit key', oldAudit, secrets);
  const credentials = JSON.stringify([
    { id: 'runtime-local', token: runtime.value, roles: ['runtime'] },
    { id: 'dashboard-local', token: dashboard.value, roles: ['admin', 'operator', 'auditor'] },
  ]);
  env.setValue('ASGUARD_API_CREDENTIALS', credentials);
  env.setValue('ASGUARD_AUDIT_KEY', audit.value);
  const outputActions = [
    await secretOutput(prompter, 'dashboard token', dashboard.value, path.join(keyDirectory, 'dashboard-token.txt')),
    await secretOutput(prompter, 'runtime token', runtime.value),
  ];

  let validPair = false;
  if (fs.existsSync(keyFiles.privatePath) && fs.existsSync(keyFiles.publicPath)) {
    try { validateApprovalKeyPair(keyFiles.privatePath, keyFiles.publicPath); validPair = true; } catch { validPair = false; }
  }
  if (!validPair && (fs.existsSync(keyFiles.privatePath) || fs.existsSync(keyFiles.publicPath))) {
    if (!await prompter.confirm('Existing attestation files are invalid or mismatched. Regenerate with backups?', true)) {
      throw new Error('Invalid attestation keys were not changed.');
    }
  }
  const reusePair = validPair && !regenerate
    ? await prompter.confirm('Reuse the existing valid Ed25519 attestation key pair?', true) : false;
  const configuredNetwork = env.getValue('ASGUARD_NEAR_NETWORK');
  const network = await prompter.ask('NEAR network (testnet or mainnet)', {
    default: !isUnsetValue(configuredNetwork) ? configuredNetwork : 'testnet',
    validate: (value) => ['testnet', 'mainnet'].includes(value) ? undefined : 'Choose testnet or mainnet.',
  });
  if (network === 'mainnet') {
    console.log('Demos refuse mainnet. Type mainnet to confirm this production-network configuration.');
    await prompter.confirmTyped('Confirm network', 'mainnet');
  }
  env.setValue('ASGUARD_NEAR_NETWORK', network);
  const rpcDefault = nearRpcDefault(network as 'testnet' | 'mainnet');
  const knownRpcUrls = ['https://rpc.testnet.near.org', 'https://rpc.mainnet.near.org'];
  const currentRpcUrl = env.getValue('ASGUARD_NEAR_RPC_URL');
  let rpcUrl = rpcDefault;
  if (!isUnsetValue(currentRpcUrl) && !knownRpcUrls.includes(currentRpcUrl || '')) {
    try {
      validateEndpoint('ASGUARD_NEAR_RPC_URL', currentRpcUrl || '');
      rpcUrl = currentRpcUrl || rpcDefault;
    } catch {
      console.log('Ignoring invalid custom NEAR RPC URL; using the network default.');
    }
  }
  env.setValue('ASGUARD_NEAR_RPC_URL', rpcUrl);
  try { console.log(`NEAR RPC: ${await probeRpc(rpcUrl)}`); } catch { console.log('NEAR RPC: unreachable (continuing)'); }

  const optionalResult = await configureOptional(env, prompter, network, noColor, regenerate);
  if (optionalResult !== 0) return optionalResult;
  const intentsUrl = env.getValue('ASGUARD_NEAR_INTENTS_API_URL') || nearIntentsDefaults(network as 'testnet' | 'mainnet').apiUrl;
  const intentsDefaults = nearIntentsDefaults(network as 'testnet' | 'mainnet', intentsUrl === 'https://www.usetidepool.tech');
  const rows: Array<[string, Status, string]> = [
    ['ASGUARD_API_CREDENTIALS', runtime.status === 'kept' && dashboard.status === 'kept' ? 'kept' : 'set', `•••• (${credentials.length} chars)`],
    ['ASGUARD_AUDIT_KEY', audit.status, masked(audit.value)],
    ['ASGUARD_ATTESTATION_PRIVATE_KEY_PATH', reusePair ? 'kept' : 'generated', relativePosix(keyFiles.privatePath)],
    ['ASGUARD_ATTESTATION_PUBLIC_KEY_PATH', reusePair ? 'kept' : 'generated', relativePosix(keyFiles.publicPath)],
    ['ASGUARD_NEAR_NETWORK', 'set', network],
    ['ASGUARD_NEAR_RPC_URL', 'set', masked(rpcUrl)],
    ['ASGUARD_NEAR_INTENTS_API_URL', 'set', masked(intentsUrl)],
    ['ASGUARD_NEAR_INTENTS_VERIFIER', 'set', env.getValue('ASGUARD_NEAR_INTENTS_VERIFIER') || intentsDefaults.verifier],
    ['ASGUARD_AI_ENABLED', env.getValue('ASGUARD_AI_ENABLED') === 'true' ? 'set' : 'skipped', env.getValue('ASGUARD_AI_ENABLED') === 'true' ? 'enabled' : 'off'],
    ['ASGUARD_AI_API_KEY', env.getValue('ASGUARD_AI_API_KEY') ? 'set' : 'skipped', env.getValue('ASGUARD_AI_API_KEY') ? masked(env.getValue('ASGUARD_AI_API_KEY') || '') : '(empty)'],
    ['ASGUARD_WATCH_DEMO_ACCOUNT', env.getValue('ASGUARD_WATCH_DEMO_ACCOUNT') ? 'set' : 'skipped', env.getValue('ASGUARD_WATCH_DEMO_ACCOUNT') || '(empty)'],
    ['ASGUARD_DEMO_SUBMIT', env.getValue('ASGUARD_DEMO_SUBMIT') === 'true' ? 'set' : 'skipped', env.getValue('ASGUARD_DEMO_SUBMIT') || 'false'],
    ['ASGUARD_DEMO_NEAR_PRIVATE_KEY', env.getValue('ASGUARD_DEMO_NEAR_PRIVATE_KEY') ? 'set' : 'skipped', env.getValue('ASGUARD_DEMO_NEAR_PRIVATE_KEY') ? masked(env.getValue('ASGUARD_DEMO_NEAR_PRIVATE_KEY') || '') : '(empty)'],
  ];
  for (const name of ['TELEGRAM_WEBHOOK_URL', 'SLACK_WEBHOOK_URL', 'DISCORD_WEBHOOK_URL', 'ASGUARD_GENERIC_WEBHOOK_URL']) {
    rows.push([name, env.getValue(name) ? 'set' : 'skipped', env.getValue(name) ? masked(env.getValue(name) || '') : '(empty)']);
  }
  console.log('\nKey                                      Status     Value');
  for (const [key, status, value] of rows) console.log(`${key.padEnd(40)} ${status.padEnd(10)} ${value}`);
  if (!await prompter.confirm('Write changes?', true)) return 0;

  if (!reusePair) {
    backupFile(keyFiles.privatePath);
    backupFile(keyFiles.publicPath);
    generateAttestationKeyPair(keyDirectory);
  }
  const privatePath = relativePosix(keyFiles.privatePath);
  const publicPath = relativePosix(keyFiles.publicPath);
  env.setValue('ASGUARD_ATTESTATION_PRIVATE_KEY_PATH', privatePath);
  env.setValue('ASGUARD_ATTESTATION_PUBLIC_KEY_PATH', publicPath);
  validateSetupValues({
    credentials,
    auditKey: audit.value,
    privatePath: keyFiles.privatePath,
    publicPath: keyFiles.publicPath,
    port: env.getValue('ASGUARD_PORT') || '8080',
    network,
    rpcUrl,
    intentsUrl,
  });
  const changed = writeEnvFile(envPath, env);
  verifyNodeEnvFile(envPath, credentials, audit.value);
  for (const action of outputActions) action();
  console.log(changed ? `Wrote ${envPath}` : `${envPath} unchanged.`);
  await offerPostSetupActions({
    interactiveTTY: Boolean(process.stdin.isTTY), yes: false, check: false, prompter,
  });
  return 0;
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

async function run(): Promise<number> {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), ['env', 'key-dir'], ['yes', 'check', 'force', 'no-color', 'help']);
    if (args.positionals.length) throw new Error(`Unexpected argument: ${args.positionals[0]}`);
    if (args.flags.has('yes') && args.flags.has('check')) throw new Error('--yes and --check cannot be combined.');
  } catch (error) {
    console.error(`[ASGUARD setup] ${safeError(error)}\n${HELP}`);
    return 2;
  }
  if (args.flags.has('help')) { console.log(HELP); return 0; }
  if (!nodeVersionValid()) { console.error('[ASGUARD setup] Requires Node.js 20.9.0 or later.'); return 1; }
  const envPath = path.resolve(args.values.get('env') || '.env');
  const keyDirectory = path.resolve(args.values.get('key-dir') || '.asguard');
  if (args.flags.has('check')) {
    try { return checkConfiguration(envPath); } catch (error) { console.error(`[ASGUARD setup] ${safeError(error)}`); return 1; }
  }
  if (!args.flags.has('yes') && !process.stdin.isTTY) {
    console.error('[ASGUARD setup] Interactive setup requires a TTY; use --yes for safe defaults or --check to validate.');
    return 2;
  }
  const env = readEnvFile(envPath);
  if (args.flags.has('yes')) {
    try {
      const keys = [
        'ASGUARD_API_CREDENTIALS', 'ASGUARD_AUDIT_KEY', 'ASGUARD_ATTESTATION_PRIVATE_KEY_PATH',
        'ASGUARD_ATTESTATION_PUBLIC_KEY_PATH', 'ASGUARD_NEAR_NETWORK', 'ASGUARD_PORT',
        'ASGUARD_NEAR_RPC_URL', 'ASGUARD_NEAR_INTENTS_API_URL', 'ASGUARD_NEAR_INTENTS_VERIFIER', 'ASGUARD_AI_ENABLED', 'ASGUARD_DEMO_SUBMIT',
        'ASGUARD_DEMO_TIDEPOOL_SETTLE', 'ASGUARD_DEMO_TIDEPOOL_FAUCET',
      ];
      const before = new Map(keys.map((key) => [key, env.getValue(key)]));
      const oldCredentials = credentialsByRole(env.getValue('ASGUARD_API_CREDENTIALS'));
      const runtimeToken = args.flags.has('force') || !oldCredentials.runtime ? uniqueSecret([]) : oldCredentials.runtime;
      const dashboardToken = args.flags.has('force') || !oldCredentials.dashboard
        ? uniqueSecret([runtimeToken]) : oldCredentials.dashboard;
      const oldAudit = args.flags.has('force') ? undefined : env.getValue('ASGUARD_AUDIT_KEY');
      const auditKey = !oldAudit || isUnsetValue(oldAudit) || Buffer.byteLength(oldAudit, 'utf8') < 32
        || oldAudit === runtimeToken || oldAudit === dashboardToken
        ? uniqueSecret([runtimeToken, dashboardToken]) : oldAudit;
      const credentials = JSON.stringify([
        { id: 'runtime-local', token: runtimeToken, roles: ['runtime'] },
        { id: 'dashboard-local', token: dashboardToken, roles: ['admin', 'operator', 'auditor'] },
      ]);
      env.setValue('ASGUARD_API_CREDENTIALS', credentials);
      env.setValue('ASGUARD_AUDIT_KEY', auditKey);
      const files = keyPaths(keyDirectory);
      let pairValid = false;
      if (!args.flags.has('force') && fs.existsSync(files.privatePath) && fs.existsSync(files.publicPath)) {
        try { validateApprovalKeyPair(files.privatePath, files.publicPath); pairValid = true; } catch { pairValid = false; }
      }
      if (!pairValid) {
        backupFile(files.privatePath);
        backupFile(files.publicPath);
        generateAttestationKeyPair(keyDirectory);
      }
      env.setValue('ASGUARD_ATTESTATION_PRIVATE_KEY_PATH', relativePosix(files.privatePath));
      env.setValue('ASGUARD_ATTESTATION_PUBLIC_KEY_PATH', relativePosix(files.publicPath));
      const configuredNetwork = env.getValue('ASGUARD_NEAR_NETWORK');
      const network = isUnsetValue(configuredNetwork) ? 'testnet' : configuredNetwork || 'testnet';
      validateNetwork(network);
      const intentsDefaults = nearIntentsDefaults(network as 'testnet' | 'mainnet');
      env.setValue('ASGUARD_NEAR_NETWORK', network);
      env.setValue('ASGUARD_PORT', isUnsetValue(env.getValue('ASGUARD_PORT')) ? '8080' : env.getValue('ASGUARD_PORT') || '8080');
      env.setValue('ASGUARD_HOST', isUnsetValue(env.getValue('ASGUARD_HOST')) ? 'localhost' : env.getValue('ASGUARD_HOST') || 'localhost');
      env.setValue('ASGUARD_ALLOWED_ORIGINS', isUnsetValue(env.getValue('ASGUARD_ALLOWED_ORIGINS')) ? 'http://localhost:3000' : env.getValue('ASGUARD_ALLOWED_ORIGINS') || 'http://localhost:3000');
      env.setValue('ASGUARD_API_URL', isUnsetValue(env.getValue('ASGUARD_API_URL')) ? 'http://localhost:8080' : env.getValue('ASGUARD_API_URL') || 'http://localhost:8080');
      env.setValue('NEXT_PUBLIC_ASGUARD_API_URL', isUnsetValue(env.getValue('NEXT_PUBLIC_ASGUARD_API_URL')) ? 'http://localhost:8080' : env.getValue('NEXT_PUBLIC_ASGUARD_API_URL') || 'http://localhost:8080');
      const currentRpcUrl = env.getValue('ASGUARD_NEAR_RPC_URL');
      const knownRpcUrls = ['https://rpc.testnet.near.org', 'https://rpc.mainnet.near.org'];
      env.setValue('ASGUARD_NEAR_RPC_URL', isUnsetValue(currentRpcUrl) || knownRpcUrls.includes(currentRpcUrl || '')
        ? nearRpcDefault(network as 'testnet' | 'mainnet') : currentRpcUrl || nearRpcDefault(network as 'testnet' | 'mainnet'));
      env.setValue('ASGUARD_NEAR_INTENTS_API_URL', intentsDefaults.apiUrl);
      env.setValue('ASGUARD_NEAR_INTENTS_VERIFIER', intentsDefaults.verifier);
      if (isUnsetValue(env.getValue('ASGUARD_AI_ENABLED'))) env.setValue('ASGUARD_AI_ENABLED', 'false');
      if (isUnsetValue(env.getValue('ASGUARD_DEMO_SUBMIT'))) env.setValue('ASGUARD_DEMO_SUBMIT', 'false');
      env.setValue('ASGUARD_DEMO_TIDEPOOL_SETTLE', 'false');
      env.setValue('ASGUARD_DEMO_TIDEPOOL_FAUCET', 'false');
      env.setValue('ASGUARD_DEMO_TIDEPOOL_ACCOUNT_ID', '');
      env.setValue('ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY', '');
      const intended = {
        credentials,
        auditKey,
        privatePath: files.privatePath,
        publicPath: files.publicPath,
        port: env.getValue('ASGUARD_PORT') || '',
        network,
        rpcUrl: env.getValue('ASGUARD_NEAR_RPC_URL') || '',
        intentsUrl: env.getValue('ASGUARD_NEAR_INTENTS_API_URL') || '',
      };
      validateSetupValues(intended);
      writeEnvFile(envPath, env);
      verifyNodeEnvFile(envPath, credentials, auditKey);
      fs.mkdirSync(keyDirectory, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') {
        fs.chmodSync(files.privatePath, 0o600);
        fs.chmodSync(files.publicPath, 0o644);
      }
      for (const key of keys) {
        const status = before.get(key) === env.getValue(key) ? 'unchanged' : before.get(key) === undefined ? 'generated' : 'set';
        console.log(`${key}: ${status}`);
      }
      console.log(`Attestation key pair: ${pairValid ? 'kept' : 'generated'}`);
      console.log(writeDashboardToken(path.join(keyDirectory, 'dashboard-token.txt'), dashboardToken));
      console.log('Setup complete.');
      return 0;
    } catch (error) {
      console.error(`[ASGUARD setup] ${safeError(error)}`);
      return 1;
    }
  }
  try {
    return await interactive(env, envPath, keyDirectory, args.flags.has('force'), args.flags.has('no-color'));
  } catch (error) {
    const code = error && typeof error === 'object' && 'exitCode' in error ? Number(error.exitCode) : 1;
    if (code !== 130) console.error(`[ASGUARD setup] ${safeError(error)}`);
    return code === 130 ? 130 : 1;
  }
}

void run().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
  console.error(`[ASGUARD setup] ${safeError(error)}`);
  process.exitCode = 1;
});
