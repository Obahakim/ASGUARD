import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';

const root = process.cwd();
const entry = path.join(root, 'cli', 'connect.ts');
const runtimeToken = 'test-runtime-token-abcdefghijklmnopqrstuvwxyz';

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function runConnect(project: string, baseUrl: string, token = runtimeToken, extra: string[] = []) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--require', './scripts/test-preload.cjs', '--import', 'tsx', entry, '--project', project, '--yes',
      '--url', baseUrl, '--agent-id', 'test-agent', '--agent-name', 'Test Agent',
      '--network', 'near:testnet', '--accounts', 'alice.testnet', ...extra,
    ], {
      cwd: root,
      env: { ...process.env, ASGUARD_RUNTIME_TOKEN: token },
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function responsePublicKey(res: http.ServerResponse, publicPem: string): void {
  const publicKey = createPublicKey(publicPem);
  const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ algorithm: 'ed25519', public_key_pem: publicPem, fingerprint_sha256: fingerprint }));
}

test('connect --yes writes private config and generated assets using a loopback stub', async (context) => {
  const pair = generateKeyPairSync('ed25519');
  const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  let connectCalls = 0;
  const stub = await listen((req, res) => {
    if (req.url === '/api/attestation/public-key' && req.method === 'GET') {
      responsePublicKey(res, publicPem);
      return;
    }
    if (req.url === '/api/agents/connect' && req.method === 'POST') {
      connectCalls += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, agent_id: 'test-agent', accounts: ['alice.testnet'] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  context.after(() => new Promise<void>((resolve) => stub.server.close(() => resolve())));

  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-connect-project-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'sample-agent', type: 'module', devDependencies: { typescript: '^5' } }));
  fs.writeFileSync(path.join(project, 'tsconfig.json'), '{}');

  const result = await runConnect(project, stub.baseUrl);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(connectCalls, 1);
  for (const name of ['.env.asguard', 'asguard.guard.ts', 'asguard-check.mjs', path.join('asguard', 'attestation-public.pem')]) {
    assert.equal(fs.existsSync(path.join(project, name)), true, name);
  }
  const env = fs.readFileSync(path.join(project, '.env.asguard'), 'utf8');
  assert.equal(env.includes(runtimeToken), true);
  assert.equal(result.stdout.includes(runtimeToken), false);
  assert.equal(result.stderr.includes(runtimeToken), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(project, '.env.asguard')).mode & 0o777, 0o600);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(project, 'asguard', 'attestation-public.pem')).mode & 0o777, 0o644);
  assert.equal(fs.readFileSync(path.join(project, 'asguard', 'attestation-public.pem'), 'utf8').includes('PRIVATE KEY'), false);
  assert.match(fs.readFileSync(path.join(project, 'asguard.guard.ts'), 'utf8'), /guardedTransfer/);
});

test('connect handles 401 and 403; dry-run does not POST or write files', async (context) => {
  const pair = generateKeyPairSync('ed25519');
  const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  let connectStatus = 401;
  let postCalls = 0;
  const stub = await listen((req, res) => {
    if (req.url === '/api/attestation/public-key') {
      responsePublicKey(res, publicPem);
      return;
    }
    if (req.url === '/api/agents/connect') {
      postCalls += 1;
      res.writeHead(connectStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: connectStatus === 401 ? 'Invalid or expired token.' : 'Insufficient role.' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  context.after(() => new Promise<void>((resolve) => stub.server.close(() => resolve())));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-connect-errors-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));

  const unauthorized = await runConnect(project, stub.baseUrl);
  assert.equal(unauthorized.status, 1);
  assert.match(unauthorized.stderr, /401/);
  connectStatus = 403;
  const forbidden = await runConnect(project, stub.baseUrl);
  assert.equal(forbidden.status, 1);
  assert.match(forbidden.stderr, /403/);
  connectStatus = 200;
  const dryRun = await runConnect(project, stub.baseUrl, runtimeToken, ['--dry-run']);
  assert.equal(dryRun.status, 0, `${dryRun.stdout}\n${dryRun.stderr}`);
  assert.equal(postCalls, 2);
  assert.equal(fs.readdirSync(project).length, 0);
});

test('--yes --json connects without prompts and is idempotent', async (context) => {
  const pair = generateKeyPairSync('ed25519');
  const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const stub = await listen((req, res) => {
    if (req.url === '/api/attestation/public-key') { responsePublicKey(res, publicPem); return; }
    if (req.url === '/api/agents/connect') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, agent_id: 'test-agent', accounts: [{ account_id: 'alice.testnet', network: 'near:testnet', id: 'watch-1' }] }));
      return;
    }
    res.writeHead(404); res.end();
  });
  context.after(() => new Promise<void>((resolve) => stub.server.close(() => resolve())));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-connect-json-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.writeFileSync(path.join(project, 'package.json'), '{\n  "name": "json-agent",\n  "devDependencies": { "typescript": "^5" }\n}\n');

  const first = await runConnect(project, stub.baseUrl, runtimeToken, ['--json']);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  const report = JSON.parse(first.stdout) as { verdict: string; connected: boolean; accounts: string[]; scripts: Record<string, string>; files: { written: string[]; skipped: string[]; conflicts: string[] }; keyExposures: number };
  assert.equal(report.verdict, 'GUARDED');
  assert.equal(report.connected, true);
  assert.deepEqual(report.accounts, ['alice.testnet']);
  assert.equal(report.scripts['asguard:check'], 'installed');
  assert.equal(report.keyExposures, 0);
  assert.equal(first.stdout.includes(runtimeToken), false);
  const before = ['package.json', '.env.asguard', 'asguard.guard.ts', 'asguard-check.mjs', 'asguard/attestation-public.pem']
    .map((name) => [name, fs.readFileSync(path.join(project, name))] as const);
  const second = await runConnect(project, stub.baseUrl, runtimeToken, ['--json']);
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.deepEqual(['package.json', '.env.asguard', 'asguard.guard.ts', 'asguard-check.mjs', 'asguard/attestation-public.pem']
    .map((name) => [name, fs.readFileSync(path.join(project, name))] as const), before);
});

test('--yes readiness reports CONNECTED for remaining signing calls and writes CI only when requested', async (context) => {
  const pair = generateKeyPairSync('ed25519');
  const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const stub = await listen((req, res) => {
    if (req.url === '/api/attestation/public-key') { responsePublicKey(res, publicPem); return; }
    if (req.url === '/api/agents/connect') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, agent_id: 'test-agent', accounts: ['alice.testnet'] }));
      return;
    }
    res.writeHead(404); res.end();
  });
  context.after(() => new Promise<void>((resolve) => stub.server.close(() => resolve())));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-connect-connected-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"connected-agent","devDependencies":{"typescript":"^5"}}\n');
  fs.writeFileSync(path.join(project, 'agent.js'), 'wallet.sendMoney(1);\n');
  const result = await runConnect(project, stub.baseUrl, runtimeToken, ['--json', '--ci']);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout) as { verdict: string; remaining: Array<{ rule: string }>; files: { written: string[] } };
  assert.equal(report.verdict, 'CONNECTED');
  assert.equal(report.remaining[0]?.rule, 'SIGN-NEAR');
  assert.equal(report.files.written.includes('.github/workflows/asguard-check.yml'), true);
  assert.equal(fs.existsSync(path.join(project, '.github', 'workflows', 'asguard-check.yml')), true);
});

test('--apply-guard wraps the simple sendMoney pattern and leaves the checker clean', async (context) => {
  const pair = generateKeyPairSync('ed25519');
  const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const stub = await listen((req, res) => {
    if (req.url === '/api/attestation/public-key') { responsePublicKey(res, publicPem); return; }
    if (req.url === '/api/agents/connect') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, agent_id: 'test-agent', accounts: ['alice.testnet'] }));
      return;
    }
    res.writeHead(404); res.end();
  });
  context.after(() => new Promise<void>((resolve) => stub.server.close(() => resolve())));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-connect-codemod-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"codemod-agent","devDependencies":{"typescript":"^5"}}\n');
  fs.writeFileSync(path.join(project, 'tsconfig.json'), '{}');
  fs.writeFileSync(path.join(project, 'agent.ts'), "import { connect } from 'near-api-js';\nconst outcome = await acct.sendMoney(receiver, amount);\n");
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: project, shell: false }).status, 0);
  spawnSync('git', ['add', 'package.json', 'tsconfig.json', 'agent.ts'], { cwd: project, shell: false });
  spawnSync('git', ['-c', 'user.name=ASGUARD Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: project, shell: false });
  const result = await runConnect(project, stub.baseUrl, runtimeToken, ['--apply-guard', '--json']);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout) as { verdict: string; applied: Array<{ file: string; line: number }>; remaining: unknown[] };
  assert.equal(report.verdict, 'GUARDED');
  assert.deepEqual(report.applied, [{ file: 'agent.ts', line: 2 }]);
  assert.equal(report.remaining.length, 0);
  const source = fs.readFileSync(path.join(project, 'agent.ts'), 'utf8');
  assert.match(source, /const outcome = await guardedTransfer/);
  assert.match(source, /receiver: receiver, amount: String\(amount\)/);
});

test('connect check emits JSON, returns findings, and refuses the ASGUARD repository itself', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-connect-scan-'));
  try {
    fs.writeFileSync(path.join(project, 'agent.js'), 'wallet.sendMoney(1);\n');
    const scan = spawnSync(process.execPath, ['--require', './scripts/test-preload.cjs', '--import', 'tsx', entry, '--check', '--json', '--project', project], {
      cwd: root, encoding: 'utf8', shell: false,
    });
    assert.equal(scan.status, 1);
    assert.equal((JSON.parse(scan.stdout) as { findings: unknown[] }).findings.length, 1);
    const badProject = spawnSync(process.execPath, ['--require', './scripts/test-preload.cjs', '--import', 'tsx', entry, '--check', '--project', path.join(project, 'missing')], {
      cwd: root, encoding: 'utf8', shell: false,
    });
    assert.equal(badProject.status, 2);
    const self = spawnSync(process.execPath, ['--require', './scripts/test-preload.cjs', '--import', 'tsx', entry, '--check', '--project', root], {
      cwd: root, encoding: 'utf8', shell: false,
    });
    assert.equal(self.status, 2);
    assert.match(self.stderr, /Refusing/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
