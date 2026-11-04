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
import { installCheckScript, updateProjectGitignore, writeCiWorkflow } from './lib/projectSetup';
import * as ts from 'typescript';
import { applySendMoneyGuard } from './lib/codemod';

const HELP = `Connect an agent project to a running ASGUARD.

Usage: npm run connect -- [--project <dir>] [--yes ...] [--check [--json] [--warn-only]] [--dry-run]
  --url <url>            ASGUARD base URL (non-interactive mode)
  --agent-id <id>        Agent ID
  --agent-name <name>    Agent display name
  --network <network>    near:testnet or near:mainnet
  --accounts <a,b,...>   Comma-separated public NEAR account IDs
  --project <dir>        Agent project directory (default cwd)
  --check                Scan only; this is pattern matching, not proof of safety
  --json                 JSON summary with --yes; scanner JSON with --check
  --warn-only            Return zero for findings with --check
  --dry-run              Print the plan; do not connect or write files
  --yes                  Non-interactive; requires all connection values above and ASGUARD_RUNTIME_TOKEN
  --apply-guard          Apply the conservative sendMoney codemod (requires --yes)
  --ci                   Add a GitHub Actions check workflow
  --sdk <mode>           SDK import mode: relative or package (default relative)
  --install-sdk          Permit building and installing the local SDK package
  --no-scripts           Skip adding the asguard:check package script
  --force                Overwrite existing generated files
  --force-no-git         Allow codemod without git; a backup is still required
  --patch <file>         Write a codemod patch without editing source files
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
let jsonConnectMode = false;
let setupFailure = false;
const summary = {
  verdict: 'NEEDS ATTENTION', connected: false, accounts: [] as string[],
  files: { written: [] as string[], skipped: [] as string[], conflicts: [] as string[] },
  scripts: { 'asguard:check': 'skipped' as 'installed' | 'conflict' | 'skipped' },
  applied: [] as Array<{ file: string; line: number }>,
  remaining: [] as Array<{ file: string; line: number; rule: string }>,
  keyExposures: 0, notes: [] as string[],
};
const originalConsoleLog = console.log.bind(console);
console.log = (...values: unknown[]) => { if (!jsonConnectMode) originalConsoleLog(...values); };

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

function runChecker(project: string, json = false, warnOnly = false): { status: number; stdout: string; stderr: string; summary?: { findings: Array<{ rule: string; file?: string; line?: number; severity?: string }>; summary: { key_exposures: number; guarded?: number } } } {
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
  if (jsonConnectMode) {
    const scan = runChecker(project, true, true);
    if (scan.summary) {
      summary.remaining = scan.summary.findings.map((finding) => ({
        file: (finding as { file?: string }).file || '', line: (finding as { line?: number }).line || 0, rule: finding.rule,
      }));
      summary.keyExposures = scan.summary.summary.key_exposures;
    }
    return scan.status === 2 ? 2 : 0;
  }
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

function finishVerdict(project: string, connected: boolean, accountIds: string[], metadata: ProjectMetadata, scriptStatus: 'installed' | 'conflict' | 'skipped', noScripts: boolean): number {
  const scan = runChecker(project, true, true);
  const findings = scan.summary?.findings ?? [];
  summary.remaining = findings.map((finding) => ({
    file: (finding as { file?: string }).file || '', line: (finding as { line?: number }).line || 0, rule: finding.rule,
  }));
  summary.keyExposures = scan.summary?.summary.key_exposures ?? 0;
  summary.connected = connected && accountIds.length > 0;
  summary.accounts = accountIds;
  summary.scripts['asguard:check'] = noScripts ? 'skipped' : scriptStatus;
  const envPath = path.join(project, '.env.asguard');
  const keyPath = path.join(project, 'asguard', 'attestation-public.pem');
  const guardPath = path.join(project, metadata.typescript ? 'asguard.guard.ts' : 'asguard.guard.js');
  const checkerPath = path.join(project, 'asguard-check.mjs');
  let envValid = false;
  try {
    const env = EnvFile.parse(fs.readFileSync(envPath, 'utf8'));
    const token = env.getValue('ASGUARD_RUNTIME_TOKEN') || '';
    const endpoint = env.getValue('ASGUARD_API_URL') || '';
    envValid = Buffer.byteLength(token, 'utf8') >= 32
      && Boolean(env.getValue('ASGUARD_AGENT_ID')?.trim()) && Boolean(env.getValue('ASGUARD_AGENT_NAME')?.trim())
      && Boolean(env.getValue('ASGUARD_NETWORK')?.trim()) && Boolean(env.getValue('ASGUARD_AGENT_ACCOUNT_IDS')?.trim())
      && Boolean(env.getValue('ASGUARD_ATTESTATION_PUBLIC_KEY_PATH')?.trim());
    validateEndpoint('ASGUARD base URL', endpoint);
  } catch { envValid = false; }
  let keyValid = false;
  try { publicFingerprint(fs.readFileSync(keyPath, 'utf8')); keyValid = true; } catch { keyValid = false; }
  let guardValid = fs.existsSync(guardPath);
  if (guardValid && !metadata.typescript) guardValid = spawnSync(process.execPath, ['--check', guardPath], { cwd: project, encoding: 'utf8', shell: false }).status === 0;
  if (guardValid && metadata.typescript) {
    try {
      guardValid = !ts.transpileModule(fs.readFileSync(guardPath, 'utf8'), { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext } }).diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
    } catch { guardValid = false; }
  }
  const scanClean = scan.status === 0 && findings.every((finding) => finding.severity !== 'error');
  const checklist = [
    ['Connection returned watched accounts', summary.connected], ['.env.asguard fields validate', envValid],
    ['Ed25519 public key is valid', keyValid], ['Guard module passes syntax check', guardValid],
    ['asguard:check script is installed or skipped by request', noScripts || scriptStatus === 'installed'],
    ['Embedded checker has no error findings', scanClean],
  ];
  const allComplete = checklist.every(([, done]) => done) && !setupFailure;
  summary.verdict = allComplete ? 'GUARDED' : !setupFailure && summary.connected && envValid && keyValid && guardValid ? 'CONNECTED' : 'NEEDS ATTENTION';
  if (!jsonConnectMode) {
    for (const [label, done] of checklist) console.log(`${done ? '✔' : '✘'} ${label}`);
    console.log(summary.verdict);
    if (summary.remaining.length) for (const finding of summary.remaining) {
      console.log(`${finding.file}:${finding.line} ${finding.rule}`);
      console.log(finding.rule === 'SIGN-NEAR' ? '  guardedTransfer(transfer, async () => account.sendMoney(receiver, amount))'
        : finding.rule.startsWith('KEY-') ? '  Move the key into the guarded callback\'s own environment.'
          : '  See agent-sdk/README.md for the guarded signing pattern.');
    }
    if (findings.length === 0) console.log('No signing calls were detected. If your agent signs through other means, review it manually.');
    console.log('Manual review remains necessary for functionCall, signAndSendTransaction, addKey, deleteKey, Chain Signatures (v1.signer), EVM signing, and keys loaded in the agent process. The codemod fixes only the simple sendMoney pattern.');
    console.log('GUARDED means no unguarded signing was detected by pattern matching. It is not proof. ASGUARD\'s wallet watch is your runtime backstop.');
  }
  if (findings.length === 0) summary.notes.push('No signing calls were detected. If your agent signs through other means, review it manually.');
  return allComplete ? 0 : 1;
}

async function runCodemod(project: string, guardPath: string, flags: Set<string>, patchPath: string | undefined, yes: boolean, prompter?: Prompter): Promise<void> {
  if (!flags.has('apply-guard') && !patchPath) return;
  const result = await applySendMoneyGuard({
    project, guardPath, yes, apply: flags.has('apply-guard'), forceNoGit: flags.has('force-no-git'), patchPath,
    prompter, printDiff: !jsonConnectMode,
    verify: (expected) => {
      const scan = runChecker(project, true, true);
      return scan.summary?.summary.guarded !== undefined && scan.summary.summary.guarded >= expected;
    },
  });
  summary.applied.push(...result.applied);
  summary.notes.push(...result.notes);
  summary.notes.push(...result.skipped.map((match) => `${match.file}:${match.line} ${match.reason || 'not transformed'}`));
  if (result.patch) summary.notes.push(`Patch written to ${path.relative(project, result.patch).split(path.sep).join('/')}.`);
  if (flags.has('apply-guard') && !result.applied.length && result.notes.some((note) => /refused|failed|skipped: project/i.test(note))) setupFailure = true;
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

function targetPaths(project: string, typescript: boolean, overwrite: boolean): Array<SelectedTarget | undefined> {
  const names = ['.env.asguard', path.join('asguard', 'attestation-public.pem'),
    typescript ? 'asguard.guard.ts' : 'asguard.guard.js', 'asguard-check.mjs'];
  return names.map((name) => {
    const target = path.join(project, name);
    if (!fs.existsSync(target)) return { path: target, overwrite: false };
    if (overwrite) return { path: target, overwrite: true };
    return undefined;
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
  force = false,
): string[] {
  const files = selections ?? targetPaths(project, metadata.typescript, force);
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

async function installProjectExtras(
  project: string,
  prompter: Prompter | undefined,
  options: { noScripts: boolean; ci: boolean; yes: boolean },
): Promise<void> {
  if (options.noScripts) summary.scripts['asguard:check'] = 'skipped';
  else {
    try {
      const status = installCheckScript(project);
      summary.scripts['asguard:check'] = status;
      if (status === 'conflict') summary.files.conflicts.push('package.json scripts.asguard:check');
      else if (status === 'installed' && fs.existsSync(path.join(project, 'package.json'))) summary.files.written.push('package.json');
      else summary.files.skipped.push('package.json (missing)');
    } catch { setupFailure = true; summary.notes.push('Could not update package.json.'); }
  }
  try {
    if (updateProjectGitignore(project)) summary.files.written.push('.gitignore');
    else summary.files.skipped.push('.gitignore (not a git repository)');
  } catch { setupFailure = true; summary.notes.push('Could not update .gitignore.'); }

  let addCi = options.ci;
  if (!options.yes && !options.ci && prompter) {
    const workflows = path.join(project, '.github', 'workflows');
    addCi = await prompter.confirm('Add a GitHub Actions workflow that runs the check?', fs.existsSync(workflows));
  }
  if (addCi) {
    try {
      const existing = path.join(project, '.github', 'workflows', 'asguard-check.yml');
      let useNew = options.yes;
      if (!useNew && prompter && fs.existsSync(existing)) useNew = await prompter.confirm('Workflow already exists. Write asguard-check.yml.new?', false);
      const workflow = writeCiWorkflow(project, useNew);
      if (workflow) summary.files.written.push(path.relative(project, workflow).split(path.sep).join('/'));
      else if (fs.existsSync(existing)) summary.files.conflicts.push('.github/workflows/asguard-check.yml');
    } catch { setupFailure = true; summary.notes.push('Could not write CI workflow.'); }
  }
}

async function interactiveConnect(
  project: string,
  metadata: ProjectMetadata,
  dryRun: boolean,
  noColor: boolean,
  flags: Set<string>,
  sdkPreference?: SdkImportChoice,
  patchPath?: string,
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
  const packageInstalled = metadata.hasSdkDependency || fs.existsSync(path.join(project, 'node_modules', 'asguard'));
  const sdkMode: SdkImportChoice = sdkPreference ?? (packageInstalled ? 'package' : 'relative');
  if (sdkMode === 'relative') console.log('The relative SDK import is for development with tsx and is not suitable for production.');
  else if (!metadata.hasSdkDependency && !fs.existsSync(path.join(project, 'node_modules', 'asguard'))) {
    console.log('asguard/agent-sdk is not installed here. Part C is not available; use the relative SDK import or install a built package later.');
  }

  console.log(`\nThis registers ${accounts.length} read-only watches on ${displayEndpoint(baseUrl)} for agent ${agentId}. Continue? [Y/n]`);
  if (!await prompter.confirm('Continue?', true)) return 0;
  if (dryRun) {
    console.log('Dry run plan: connect to ASGUARD; fetch and verify the Ed25519 key; write .env.asguard, public key, guard, and checker; update package.json and .gitignore; optionally write CI and apply the conservative sendMoney codemod. No network write or file write was made.');
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
  const written = writeGeneratedFiles(project, metadata, sdkMode === 'package' && packageInstalled ? 'package' : 'relative', { baseUrl, token, agentId, agentName, network, accounts, keyPem: key }, files);
  summary.files.written.push(...written.map((file) => path.relative(project, file).split(path.sep).join('/')));
  summary.files.skipped.push(...files.flatMap((target, index) => target ? [] : [path.basename(['.env.asguard', 'asguard/attestation-public.pem', metadata.typescript ? 'asguard.guard.ts' : 'asguard.guard.js', 'asguard-check.mjs'][index]) ]));
  await installProjectExtras(project, prompter, { noScripts: flags.has('no-scripts'), ci: flags.has('ci'), yes: false });
  const guardPath = files[2]?.path || path.join(project, metadata.typescript ? 'asguard.guard.ts' : 'asguard.guard.js');
  await runCodemod(project, guardPath, flags, patchPath, false, prompter);
  summary.connected = true;
  summary.accounts = registered.flatMap((account) => typeof account === 'string' ? [account] : account && typeof account === 'object' && typeof (account as Record<string, unknown>).account_id === 'string' ? [(account as Record<string, unknown>).account_id as string] : []);
  const scriptStatus = summary.scripts['asguard:check'];
  for (const file of files.flatMap((target) => target ? [target.path] : [])) {
    console.log(`Wrote ${path.relative(project, file).split(path.sep).join('/')}`);
  }
  if (metadata.typescript) console.log('Suggested package.json script: "asguard:check": "node asguard-check.mjs"');
  console.log('Next steps: run node --env-file=.env.asguard <entry>, then call guardedTransfer(...) around the signing callback.');
  console.log('Add asguard:check to CI. Move private keys out of the agent process and into the guarded callback.');
  console.log('connectAgent registers watches only; accounts are agent-declared and the scan is pattern matching, not proof.');
  return finishVerdict(project, true, summary.accounts, metadata, scriptStatus, flags.has('no-scripts'));
}

async function run(): Promise<number> {
  const usage = 'Usage error. Run npm run connect -- --help.';
  let args;
  try {
    args = parseArgs(process.argv.slice(2),
      ['project', 'url', 'agent-id', 'agent-name', 'network', 'accounts', 'sdk', 'patch'],
      ['check', 'json', 'warn-only', 'dry-run', 'yes', 'no-color', 'help', 'allow-self', 'apply-guard', 'ci', 'install-sdk', 'no-scripts', 'force', 'force-no-git']);
    if (args.positionals.length) throw new Error(`Unexpected argument: ${args.positionals[0]}`);
    if (args.flags.has('json') && !args.flags.has('check') && !args.flags.has('yes')) throw new Error('--json requires --check or --yes.');
    if (args.flags.has('warn-only') && !args.flags.has('check')) throw new Error('--warn-only is only valid with --check.');
    if (args.flags.has('check') && args.flags.has('dry-run')) throw new Error('--check and --dry-run cannot be combined.');
    if (args.values.has('sdk') && !['relative', 'package'].includes(args.values.get('sdk') || '')) throw new Error('--sdk must be relative or package.');
    jsonConnectMode = args.flags.has('json') && args.flags.has('yes') && !args.flags.has('check');
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
    if (args.flags.has('dry-run')) {
      if (!jsonConnectMode) console.log('Dry run plan: register the declared accounts; fetch and verify the public key; write generated files; install asguard:check; update .gitignore; optionally write CI and apply the sendMoney codemod. No connect POST or file write was made.');
      return reportScan(project);
    }
    const packageInstalled = metadata.hasSdkDependency || fs.existsSync(path.join(project, 'node_modules', 'asguard'));
    const sdkMode: SdkImportChoice = (args.values.get('sdk') as SdkImportChoice | undefined) ?? (packageInstalled ? 'package' : 'relative');
    if (sdkMode === 'package' && !packageInstalled) {
      summary.notes.push('asguard/agent-sdk is not installed; using the relative SDK import.');
    }
    if (sdkMode === 'relative' && !jsonConnectMode) console.log('Using a development-only relative SDK import; this is not suitable for production.');
    const expectedFiles = ['.env.asguard', 'asguard/attestation-public.pem', metadata.typescript ? 'asguard.guard.ts' : 'asguard.guard.js', 'asguard-check.mjs'];
    const files = writeGeneratedFiles(project, metadata, sdkMode === 'package' && packageInstalled ? 'package' : 'relative', {
      baseUrl, token, agentId, agentName, network, accounts, keyPem: key.pem,
    }, undefined, args.flags.has('force'));
    summary.files.written.push(...files.map((file) => path.relative(project, file).split(path.sep).join('/')));
    for (const file of expectedFiles) if (!files.some((written) => path.relative(project, written).split(path.sep).join('/') === file)) summary.files.skipped.push(file);
    await installProjectExtras(project, undefined, { noScripts: args.flags.has('no-scripts'), ci: args.flags.has('ci'), yes: true });
    const guardPath = files.find((file) => path.basename(file).startsWith('asguard.guard.')) || path.join(project, metadata.typescript ? 'asguard.guard.ts' : 'asguard.guard.js');
    await runCodemod(project, guardPath, args.flags, args.values.get('patch'), true);
    summary.connected = true;
    summary.accounts = response && Array.isArray(response.accounts) ? response.accounts.flatMap((account) => typeof account === 'string' ? [account] : account && typeof account === 'object' && typeof (account as Record<string, unknown>).account_id === 'string' ? [(account as Record<string, unknown>).account_id as string] : []) : [];
    for (const file of files) console.log(`Wrote ${path.relative(project, file).split(path.sep).join('/')}`);
    const scanStatus = finishVerdict(project, true, summary.accounts, metadata, summary.scripts['asguard:check'], args.flags.has('no-scripts'));
    console.log('Suggested package.json script: "asguard:check": "node asguard-check.mjs"');
    console.log('Next steps: run node --env-file=.env.asguard <entry>, then call guardedTransfer(...) around the signing callback.');
    console.log('Add asguard:check to CI. Move private keys out of the agent process and into the guarded callback.');
    console.log('connectAgent registers watches only; accounts are agent-declared and the scan is pattern matching, not proof.');
    return scanStatus;
  }
  try {
    return await interactiveConnect(project, metadata, args.flags.has('dry-run'), args.flags.has('no-color'), args.flags, args.values.get('sdk') as SdkImportChoice | undefined, args.values.get('patch'));
  } catch (error) {
    const code = error && typeof error === 'object' && 'exitCode' in error ? Number(error.exitCode) : 1;
    if (code !== 130) console.error(`Connect failed: ${safeError(error)}`);
    return code === 130 ? 130 : 1;
  }
}

void run().then((code) => {
  if (jsonConnectMode) process.stdout.write(JSON.stringify(summary) + '\n');
  process.exitCode = code;
}).catch((error: unknown) => {
  console.error(`Connect failed: ${safeError(error)}`);
  process.exitCode = 1;
});
