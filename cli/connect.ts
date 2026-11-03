import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { connectAgent, AsguardApprovalError } from '../agent-sdk/index';
import { parseApprovalPublicKey } from '../lib/approvalAttestation';
import { createPrompter, type Prompter } from './lib/prompt';
import { parseArgs } from './lib/args';
import { EnvFile } from './lib/envFile';
import { buildGuardTemplate, type SdkImportChoice } from './lib/guardTemplates';
import { CHECKER_SOURCE } from './lib/checkerTemplate';
import { probeReachability } from './lib/probe';
import { validateEndpoint } from './lib/validate';

const HELP = `Connect an agent project to a running ASGUARD.

Usage: npm run connect -- [--project <dir>] [--check [--json] [--warn-only]] [--dry-run]
  --url <url>            ASGUARD base URL (non-interactive mode)
  --agent-id <id>        Agent ID
  --agent-name <name>    Agent display name
  --network <network>    near:testnet or near:mainnet
  --accounts <a,b,...>   Comma-separated public NEAR account IDs
  --project <dir>        Agent project directory (default cwd)
  --check                Scan only; this is pattern matching, not proof of safety
  --json                 JSON output with --check
  --warn-only            Return zero for findings with --check
  --dry-run              Print the plan; do not connect or write files
  --yes                  Non-interactive; requires all connection values above and ASGUARD_RUNTIME_TOKEN
  --no-color             Disable ANSI color
  --help                 Show this help

connectAgent only registers watched accounts; it does not enforce signing controls.
Keep signing keys out of the agent process and route signing through withAsguardApproval.
Accounts are agent-declared. The scan is pattern matching only, not proof that code is safe.
`;
const agentAccountPattern = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;
const allowedNames = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.asguard', 'vendor',
]);

interface ProjectMetadata {
  hasPackageJson: boolean;
  typescript: boolean;
  esm: boolean;
  packageName: string;
  hasSdkDependency: boolean;
}
interface SelectedTarget { path: string; overwrite: boolean }

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error.';
}

function printAccounts(accounts: unknown[]): void {
  console.log('\nAccount ID                              Network         Watch ID');
  for (const account of accounts) {
    if (typeof account === 'object' && account !== null) {
      const record = account as Record<string, unknown>;
      console.log(`${String(record.account_id || '').padEnd(40)} ${String(record.network || '').padEnd(15)} ${String(record.id || '')}`);
    } else console.log(String(account));
  }
}

function readProjectMetadata(project: string): ProjectMetadata {
  const packagePath = path.join(project, 'package.json');
  if (!fs.existsSync(packagePath)) {
    console.log('No package.json found; continuing in scan-only-friendly mode.');
    return {
      hasPackageJson: false,
      typescript: fs.existsSync(path.join(project, 'tsconfig.json')),
      esm: false,
      packageName: '',
      hasSdkDependency: false,
    };
  }
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as {
    name?: unknown;
    type?: unknown;
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
  };
  const hasTypescript = Boolean(pkg.dependencies?.typescript || pkg.devDependencies?.typescript);
  return {
    hasPackageJson: true,
    typescript: fs.existsSync(path.join(project, 'tsconfig.json')) || hasTypescript,
    esm: pkg.type === 'module',
    packageName: typeof pkg.name === 'string' ? pkg.name : '',
    hasSdkDependency: Boolean(pkg.dependencies?.asguard || pkg.devDependencies?.asguard),
  };
}

function validateAgentId(value: string): string | undefined {
  return value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9._-]+$/.test(value)
    ? undefined : 'Agent ID must be 1-128 characters using letters, digits, dot, underscore, or hyphen.';
}

function validateLabel(value: string): string | undefined {
  return value.trim().length >= 1 && value.length <= 128 ? undefined : 'Value must be 1-128 characters.';
}

function displayEndpoint(value: string): string {
  return new URL(value).origin;
}

function validateAccounts(value: string): string | undefined {
  const accounts = value.split(',').map((account) => account.trim()).filter(Boolean);
  return accounts.length >= 1 && accounts.length <= 20
    && accounts.every((account) => account.length <= 64 && agentAccountPattern.test(account))
    ? undefined : 'Enter 1-20 valid public NEAR account IDs, separated by commas.';
}

function isSelfProject(project: string): boolean {
  try {
    const actual = fs.realpathSync(project).toLowerCase();
    const root = fs.realpathSync(path.resolve(__dirname, '..')).toLowerCase();
    return actual === root;
  } catch {
    return false;
  }
}

function runChecker(project: string, json = false, warnOnly = false): { status: number; stdout: string; stderr: string; summary?: { findings: Array<{ rule: string }>; summary: { key_exposures: number } } } {
  const args = ['--input-type=module', '-e', CHECKER_SOURCE, '--', '--project', project];
  if (json) args.push('--json');
  if (warnOnly) args.push('--warn-only');
  const result = spawnSync(process.execPath, args, { cwd: project, encoding: 'utf8', shell: false });
  if (result.error) throw result.error;
  let summary: { findings: Array<{ rule: string }>; summary: { key_exposures: number } } | undefined;
  if (json && result.stdout) summary = JSON.parse(result.stdout) as typeof summary;
  return { status: result.status ?? 2, stdout: result.stdout || '', stderr: result.stderr || '', summary };
}

function reportScan(project: string): number {
  const result = runChecker(project);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status === 2) return 2;
  const json = runChecker(project, true, true);
  const keyExposures = json.summary?.summary.key_exposures ?? 0;
  if (keyExposures > 0) {
    console.log('A key reachable from the agent process defeats the gate. Move it into the guarded callback\'s own environment.');
  }
  return result.status;
}

function findOtherLanguageFiles(project: string): string[] {
  const found: string[] = [];
  function walk(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || (entry.isDirectory() && allowedNames.has(entry.name))) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile() && ['.py', '.go', '.rs'].includes(path.extname(entry.name))) found.push(target);
    }
  }
  walk(project);
  return found;
}

function publicFingerprint(pem: string): { pem: string; fingerprint: string } {
  const publicKey = parseApprovalPublicKey(pem);
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return {
    pem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    fingerprint: createHash('sha256').update(der).digest('hex'),
  };
}

async function fetchPublicKey(baseUrl: string): Promise<{ pem: string; fingerprint: string }> {
  validateEndpoint('ASGUARD URL', baseUrl);
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/attestation/public-key`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Could not fetch the public key (HTTP ${response.status}).`);
  const body = await response.json() as { algorithm?: unknown; public_key_pem?: unknown; fingerprint_sha256?: unknown };
  if (body.algorithm !== 'ed25519' || typeof body.public_key_pem !== 'string') throw new Error('ASGUARD returned an invalid Ed25519 public key response.');
  const parsed = publicFingerprint(body.public_key_pem);
  if (typeof body.fingerprint_sha256 !== 'string' || parsed.fingerprint !== body.fingerprint_sha256) {
    throw new Error('ASGUARD public-key fingerprint did not match the key.');
  }
  return parsed;
}

async function getPublicKey(baseUrl: string, prompter: Prompter, project: string): Promise<string> {
  const source = await prompter.choose('Attestation public key source:', [
    'fetch from ASGUARD server',
    'path to existing PEM',
    'paste PEM',
  ]);
  if (source === 'fetch from ASGUARD server') {
    const parsed = await fetchPublicKey(baseUrl);
    console.log(`Attestation public-key SHA-256 fingerprint: ${parsed.fingerprint}`);
    console.log('Confirm it matches the fingerprint shown by npm run setup -- --check on the ASGUARD server.');
    if (!await prompter.confirm('Does the fingerprint match the trusted server fingerprint?', false)) {
      throw new Error('Attestation fingerprint was not confirmed.');
    }
    return parsed.pem;
  }
  if (source === 'path to existing PEM') {
    const filePath = path.resolve(project, await prompter.ask('PEM path'));
    const pem = fs.readFileSync(filePath, 'utf8');
    const parsed = publicFingerprint(pem);
    console.log(`Attestation public-key SHA-256 fingerprint: ${parsed.fingerprint}`);
    return parsed.pem;
  }
  console.log('Paste the complete PEM, then enter END on a line by itself.');
  const lines: string[] = [];
  for (;;) {
    const line = await prompter.ask('PEM line');
    if (line === 'END') break;
    lines.push(line);
  }
  const parsed = publicFingerprint(lines.join('\n'));
  console.log(`Attestation public-key SHA-256 fingerprint: ${parsed.fingerprint}`);
  return parsed.pem;
}

function chooseTarget(project: string, name: string, prompter: Prompter): Promise<SelectedTarget | undefined> {
  const target = path.join(project, name);
  if (!fs.existsSync(target)) return Promise.resolve({ path: target, overwrite: false });
  return prompter.choose(`${name} already exists:`, ['skip', 'overwrite', `write ${name}.new`]).then((choice) => {
    if (choice === 'skip') return undefined;
    return choice === 'overwrite' ? { path: target, overwrite: true } : { path: `${target}.new`, overwrite: false };
  });
}

function writeTarget(filePath: string | undefined, contents: string, mode: number, overwrite = false): void {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, contents, { flag: overwrite ? 'w' : 'wx', mode });
  if (process.platform !== 'win32') fs.chmodSync(filePath, mode);
}

function targetPaths(project: string, typescript: boolean, overwrite: boolean): string[] {
  const names = ['.env.asguard', path.join('asguard', 'attestation-public.pem'),
    typescript ? 'asguard.guard.ts' : 'asguard.guard.js', 'asguard-check.mjs'];
  return names.map((name) => {
    const target = path.join(project, name);
    if (!fs.existsSync(target)) return target;
    if (overwrite) return target;
    let candidate = `${target}.new`;
    let suffix = 1;
    while (fs.existsSync(candidate)) {
      candidate = `${target}.new.${suffix}`;
      suffix += 1;
    }
    return candidate;
  });
}

function agentConfigFile(
  baseUrl: string,
  token: string,
  agentId: string,
  agentName: string,
  network: string,
  accounts: string[],
  publicKeyPath: string,
): string {
  const env = EnvFile.parse('');
  env.setValue('ASGUARD_API_URL', baseUrl);
  env.setValue('ASGUARD_RUNTIME_TOKEN', token);
  env.setValue('ASGUARD_AGENT_ID', agentId);
  env.setValue('ASGUARD_AGENT_NAME', agentName);
  env.setValue('ASGUARD_NETWORK', network);
  env.setValue('ASGUARD_AGENT_ACCOUNT_IDS', accounts.join(','));
  env.setValue('ASGUARD_ATTESTATION_PUBLIC_KEY_PATH', publicKeyPath);
  return env.serialize();
}

function writeGeneratedFiles(
  project: string,
  metadata: ProjectMetadata,
  sdkMode: SdkImportChoice,
  values: { baseUrl: string; token: string; agentId: string; agentName: string; network: string; accounts: string[]; keyPem: string },
  selections?: Array<SelectedTarget | undefined>,
): string[] {
  const files = selections ?? targetPaths(project, metadata.typescript, false).map((filePath) => ({ path: filePath, overwrite: false }));
  const sdkRelative = `.${path.sep}${path.relative(project, path.resolve(__dirname, '..', '..', 'agent-sdk', 'index')).split(path.sep).join('/')}`;
  const expectedPublicPath = path.join(project, 'asguard', 'attestation-public.pem');
  const actualPublicPath = files[1]?.path || expectedPublicPath;
  const publicKeyPath = path.relative(project, actualPublicPath).split(path.sep).join('/');
  let publicKeyPem = values.keyPem;
  if (!files[1]) {
    if (!fs.existsSync(expectedPublicPath)) throw new Error('Public key output was skipped, but no existing public key is available.');
    const existingPem = fs.readFileSync(expectedPublicPath, 'utf8');
    if (publicFingerprint(existingPem).fingerprint !== publicFingerprint(values.keyPem).fingerprint) {
      throw new Error('Existing public key does not match ASGUARD. Choose overwrite or a new output path.');
    }
    publicKeyPem = existingPem;
  }
  const outputs: Array<[SelectedTarget | undefined, string, number]> = [
    [files[0], agentConfigFile(values.baseUrl, values.token, values.agentId, values.agentName, values.network, values.accounts, publicKeyPath), 0o600],
    [files[1], publicKeyPem, 0o644],
    [files[2], buildGuardTemplate(
      metadata.typescript ? 'ts' : 'js',
      sdkMode,
      sdkRelative,
      metadata.esm ? 'esm' : 'cjs',
    ), 0o644],
    [files[3], CHECKER_SOURCE, 0o644],
  ];
  for (const [target, contents, mode] of outputs) {
    if (!target) continue;
    writeTarget(target.path, contents, mode, target.overwrite);
  }
  return files.flatMap((target) => target ? [target.path] : []);
}

async function interactiveConnect(
  project: string,
  metadata: ProjectMetadata,
  dryRun: boolean,
  noColor: boolean,
): Promise<number> {
  const prompter = createPrompter({ input: process.stdin, output: process.stdout, isTTY: Boolean(process.stdin.isTTY), noColor });
  const enteredBaseUrl = await prompter.askSecret('ASGUARD base URL (press Enter for http://localhost:8080)', {
    validate: (value) => {
      try { validateEndpoint('ASGUARD base URL', value || 'http://localhost:8080'); return undefined; } catch (error) { return safeError(error); }
    },
  });
  const baseUrl = enteredBaseUrl || 'http://localhost:8080';
  try { await probeReachability(baseUrl); } catch (error) {
    throw new Error(`ASGUARD is unreachable; check that the backend is running and the URL is correct. (${safeError(error)})`);
  }

  let token = process.env.ASGUARD_RUNTIME_TOKEN || '';
  if (token) {
    if (!await prompter.confirm('Reuse ASGUARD_RUNTIME_TOKEN from the environment?', true)) token = '';
  }
  if (!token) token = await prompter.askSecret('Runtime token', {
    validate: (value) => Buffer.byteLength(value, 'utf8') >= 32 ? undefined : 'Runtime token must be at least 32 bytes.',
  });
  const defaultId = metadata.packageName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
  const agentId = await prompter.ask('Agent ID', { default: defaultId, validate: validateAgentId });
  const agentName = await prompter.ask('Agent name', { default: metadata.packageName || path.basename(project), validate: validateLabel });
  const network = await prompter.choose('NEAR network:', ['near:testnet', 'near:mainnet']);
  if (network === 'near:mainnet') {
    await prompter.ask('Type mainnet to confirm', { validate: (value) => value === 'mainnet' ? undefined : 'Type mainnet to continue.' });
  }
  const accountsValue = await prompter.ask('Comma-separated public NEAR account IDs', { validate: validateAccounts });
  const accounts = accountsValue.split(',').map((account) => account.trim());

  const key = await getPublicKey(baseUrl, prompter, project);
  const sdkChoice = await prompter.choose('SDK import style:', ['relative path to this ASGUARD checkout (development only)', 'asguard/agent-sdk package (requires Part C)']);
  const sdkMode: SdkImportChoice = sdkChoice.startsWith('relative') ? 'relative' : 'package';
  if (sdkMode === 'relative') console.log('The relative SDK import is for development with tsx and is not suitable for production.');
  else if (!metadata.hasSdkDependency && !fs.existsSync(path.join(project, 'node_modules', 'asguard'))) {
    console.log('asguard/agent-sdk is not installed here. Part C is not available; use the relative SDK import or install a built package later.');
  }

  console.log(`\nThis registers ${accounts.length} read-only watches on ${displayEndpoint(baseUrl)} for agent ${agentId}. Continue? [Y/n]`);
  if (!await prompter.confirm('Continue?', true)) return 0;
  if (dryRun) {
    console.log('Dry run: would connect, save .env.asguard and the public key, and generate the guard and checker. No network write or file write was made.');
    return reportScan(project);
  }

  let response: Record<string, unknown>;
  try {
    response = await connectAgent({
      baseUrl, token, agentId, agentName,
      network: network as 'near:testnet' | 'near:mainnet',
      accountIds: accounts,
    });
  } catch (error) {
    const message = safeError(error);
    if (error instanceof AsguardApprovalError && /401|invalid.*token|unauthorized/i.test(message)) console.error('ASGUARD rejected the token (401): verify that it is the runtime token.');
    else if (error instanceof AsguardApprovalError && /403|insufficient role|forbidden/i.test(message)) console.error('ASGUARD denied the connection (403): the credential lacks the required runtime role.');
    else if (error instanceof AsguardApprovalError && /4\d\d/.test(message)) console.error(`ASGUARD rejected the request: ${message}`);
    else console.error('Could not connect to ASGUARD; check reachability and server logs.');
    return 1;
  }
  const registered = Array.isArray(response.accounts) ? response.accounts : [];
  printAccounts(registered);
  console.log('Pin limitation: account IDs are agent-declared and are not yet proven.');

  const files: Array<SelectedTarget | undefined> = [];
  files.push(await chooseTarget(project, '.env.asguard', prompter));
  files.push(await chooseTarget(project, path.join('asguard', 'attestation-public.pem'), prompter));
  files.push(await chooseTarget(project, metadata.typescript ? 'asguard.guard.ts' : 'asguard.guard.js', prompter));
  files.push(await chooseTarget(project, 'asguard-check.mjs', prompter));
  writeGeneratedFiles(project, metadata, sdkMode, { baseUrl, token, agentId, agentName, network, accounts, keyPem: key }, files);
  const ignorePath = path.join(project, '.gitignore');
  if (fs.existsSync(path.join(project, '.git')) && !fs.readFileSync(ignorePath, 'utf8').split(/\r?\n/).includes('.env.asguard')) {
    if (await prompter.confirm('Offer .env.asguard to be added to .gitignore?', true)) {
      console.log('Add this line to the project .gitignore: .env.asguard');
    }
  }
  const scanStatus = reportScan(project);
  for (const file of files.flatMap((target) => target ? [target.path] : [])) {
    console.log(`Wrote ${path.relative(project, file).split(path.sep).join('/')}`);
  }
  if (metadata.typescript) console.log('Suggested package.json script: "asguard:check": "node asguard-check.mjs"');
  console.log('Next steps: run node --env-file=.env.asguard <entry>, then call guardedTransfer(...) around the signing callback.');
  console.log('Add asguard:check to CI. Move private keys out of the agent process and into the guarded callback.');
  console.log('connectAgent registers watches only; accounts are agent-declared and the scan is pattern matching, not proof.');
  return scanStatus;
}

async function run(): Promise<number> {
  const usage = 'Usage error. Run npm run connect -- --help.';
  let args;
  try {
    args = parseArgs(process.argv.slice(2),
      ['project', 'url', 'agent-id', 'agent-name', 'network', 'accounts'],
      ['check', 'json', 'warn-only', 'dry-run', 'yes', 'no-color', 'help', 'allow-self']);
    if (args.positionals.length) throw new Error(`Unexpected argument: ${args.positionals[0]}`);
    if (args.flags.has('json') && !args.flags.has('check')) throw new Error('--json is only valid with --check.');
    if (args.flags.has('warn-only') && !args.flags.has('check')) throw new Error('--warn-only is only valid with --check.');
    if (args.flags.has('check') && args.flags.has('dry-run')) throw new Error('--check and --dry-run cannot be combined.');
  } catch (error) {
    console.error(`${safeError(error)}\n${usage}`);
    return 2;
  }
  if (args.flags.has('help')) { console.log(HELP); return 0; }
  const project = path.resolve(args.values.get('project') || process.cwd());
  if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) {
    console.error('Project directory does not exist.');
    return 2;
  }
  if (isSelfProject(project) && !args.flags.has('allow-self')) {
    console.error('Refusing to connect or scan the ASGUARD repository itself. Tests may use hidden --allow-self.');
    return 2;
  }
  if (args.flags.has('check')) {
    if (!args.flags.has('json') && findOtherLanguageFiles(project).length) {
      console.log('Scanning supports JavaScript/TypeScript only. Use the REST API (POST /api/approvals/*, POST /api/submissions/report) from other languages.');
    }
    const result = runChecker(project, args.flags.has('json'), args.flags.has('warn-only'));
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.status;
  }
  let metadata: ProjectMetadata;
  try { metadata = readProjectMetadata(project); } catch (error) {
    console.error(`Could not read agent project metadata: ${safeError(error)}`);
    return 2;
  }
  if (metadata.typescript) console.log('Detected TypeScript project.');
  else console.log(`Detected JavaScript project (${metadata.esm ? 'ESM' : 'CommonJS'}).`);
  const otherLanguages = findOtherLanguageFiles(project);
  if (otherLanguages.length) {
    console.log('Scanning supports JavaScript/TypeScript only. Use the REST API (POST /api/approvals/*, POST /api/submissions/report) from other languages.');
  }
  if (!args.flags.has('yes') && !process.stdin.isTTY) {
    console.error('Interactive connect requires a TTY; use --check or provide all values with --yes.');
    return 2;
  }
  const connectionFlags = ['url', 'agent-id', 'agent-name', 'network', 'accounts'];
  if (!args.flags.has('yes') && connectionFlags.some((name) => args.values.has(name))) {
    console.error('--url, --agent-id, --agent-name, --network, and --accounts require --yes.');
    return 2;
  }
  if (args.flags.has('yes')) {
    const missing = connectionFlags.filter((name) => !args.values.has(name));
    const token = process.env.ASGUARD_RUNTIME_TOKEN;
    if (missing.length || !token) {
      console.error(`--yes requires --${missing.join(', --')}${!token ? `${missing.length ? ' and ' : ''}ASGUARD_RUNTIME_TOKEN in the environment` : ''}.`);
      return 2;
    }
    const baseUrl = args.values.get('url') || '';
    const agentId = args.values.get('agent-id') || '';
    const agentName = args.values.get('agent-name') || '';
    const network = args.values.get('network') || '';
    const accounts = (args.values.get('accounts') || '').split(',').map((account) => account.trim());
    if (validateAgentId(agentId) || validateLabel(agentName) || !['near:testnet', 'near:mainnet'].includes(network)
      || validateAccounts(accounts.join(','))) {
      console.error('Invalid agent ID, name, network, or account list.');
      return 2;
    }
    if (network === 'near:mainnet') {
      console.error('--yes cannot confirm the required typed mainnet acknowledgement; use interactive mode.');
      return 2;
    }
    try { validateEndpoint('ASGUARD base URL', baseUrl); } catch (error) { console.error(safeError(error)); return 2; }
    try { await probeReachability(baseUrl); } catch (error) {
      console.error(`ASGUARD is unreachable; check that the backend is running and the URL is correct. (${safeError(error)})`);
      return 1;
    }
    let key: { pem: string; fingerprint: string };
    try { key = await fetchPublicKey(baseUrl); } catch (error) { console.error(`Could not load the ASGUARD public key: ${safeError(error)}`); return 1; }
    console.log(`Attestation public-key SHA-256 fingerprint: ${key.fingerprint}`);
    console.log('--yes accepts this HTTPS/local server public key; verify the fingerprint against the server setup output before production use.');
    let response: Record<string, unknown> | undefined;
    if (!args.flags.has('dry-run')) {
      try {
        response = await connectAgent({
          baseUrl, token, agentId, agentName,
          network: network as 'near:testnet' | 'near:mainnet', accountIds: accounts,
        });
      } catch (error) {
        const message = safeError(error);
        console.error(error instanceof AsguardApprovalError && /401|invalid.*token|unauthorized/i.test(message)
          ? 'ASGUARD rejected the token (401).'
          : error instanceof AsguardApprovalError && /403|insufficient role|forbidden/i.test(message)
            ? 'ASGUARD denied the connection (403).'
            : error instanceof AsguardApprovalError ? `ASGUARD rejected the connection: ${message}` : 'Could not connect to ASGUARD.');
        return 1;
      }
    }
    if (response) {
      const registered = Array.isArray(response.accounts) ? response.accounts : [];
      console.log(`Connected agent ${agentId}; received ${registered.length} accounts.`);
      printAccounts(registered);
    } else console.log(`Dry run: would register ${accounts.length} read-only watches on ${displayEndpoint(baseUrl)} for ${agentId}.`);
    console.log('Account IDs are agent-declared and not yet proven.');
    if (args.flags.has('dry-run')) return reportScan(project);
    const packageInstalled = metadata.hasSdkDependency || fs.existsSync(path.join(project, 'node_modules', 'asguard'));
    if (packageInstalled) console.log('Using the asguard/agent-sdk package import.');
    else console.log('Using a development-only relative SDK import; this is not suitable for production.');
    const files = writeGeneratedFiles(project, metadata, packageInstalled ? 'package' : 'relative', {
      baseUrl, token, agentId, agentName, network, accounts, keyPem: key.pem,
    });
    for (const file of files) console.log(`Wrote ${path.relative(project, file).split(path.sep).join('/')}`);
    const scanStatus = reportScan(project);
    console.log('Suggested package.json script: "asguard:check": "node asguard-check.mjs"');
    console.log('Next steps: run node --env-file=.env.asguard <entry>, then call guardedTransfer(...) around the signing callback.');
    console.log('Add asguard:check to CI. Move private keys out of the agent process and into the guarded callback.');
    console.log('connectAgent registers watches only; accounts are agent-declared and the scan is pattern matching, not proof.');
    return scanStatus;
  }
  try {
    return await interactiveConnect(project, metadata, args.flags.has('dry-run'), args.flags.has('no-color'));
  } catch (error) {
    const code = error && typeof error === 'object' && 'exitCode' in error ? Number(error.exitCode) : 1;
    if (code !== 130) console.error(`Connect failed: ${safeError(error)}`);
    return code === 130 ? 130 : 1;
  }
}

void run().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
  console.error(`Connect failed: ${safeError(error)}`);
  process.exitCode = 1;
});
