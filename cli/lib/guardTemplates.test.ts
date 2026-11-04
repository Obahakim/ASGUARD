import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildGuardTemplate } from './guardTemplates';

const root = process.cwd();

test('generated TypeScript guard type-checks against SDK and JavaScript guard passes node --check', (context) => {
  const tsc = path.join(root, 'node_modules', 'typescript', 'lib', 'tsc.js');
  if (!fs.existsSync(tsc)) {
    context.skip('TypeScript is not installed; generated guard compile check skipped.');
    console.log('SKIP guard compile test: TypeScript is not installed.');
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-guard-compile-'));
  try {
    const specifier = 'asguard-local-sdk';
    const tsPath = path.join(directory, 'asguard.guard.ts');
    fs.writeFileSync(tsPath, buildGuardTemplate('ts', 'relative', specifier));
    fs.writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'Node16', moduleResolution: 'Node16', lib: ['ES2022', 'DOM'],
        strict: true, esModuleInterop: true, skipLibCheck: true, noEmit: true,
        baseUrl: directory, types: ['node'], typeRoots: [path.join(root, 'node_modules', '@types')],
        paths: { [specifier]: [path.join(root, 'agent-sdk', 'index.ts')] },
      },
      include: ['asguard.guard.ts'],
    }));
    const typecheck = spawnSync(process.execPath, [tsc, '--noEmit', '-p', directory], {
      cwd: root, encoding: 'utf8', shell: false,
    });
    assert.equal(typecheck.status, 0, `${typecheck.stdout}\n${typecheck.stderr}`);

    const esmDirectory = path.join(directory, 'esm');
    fs.mkdirSync(esmDirectory);
    fs.writeFileSync(path.join(esmDirectory, 'package.json'), JSON.stringify({ type: 'module' }));
    const esmPath = path.join(esmDirectory, 'asguard.guard.js');
    fs.writeFileSync(esmPath, buildGuardTemplate('js', 'relative', specifier, 'esm'));
    const esmSyntax = spawnSync(process.execPath, ['--check', esmPath], { cwd: root, encoding: 'utf8', shell: false });
    assert.equal(esmSyntax.status, 0, `${esmSyntax.stdout}\n${esmSyntax.stderr}`);

    const cjsPath = path.join(directory, 'asguard.guard.js');
    fs.writeFileSync(cjsPath, buildGuardTemplate('js', 'relative', specifier, 'cjs'));
    const cjsSyntax = spawnSync(process.execPath, ['--check', cjsPath], { cwd: root, encoding: 'utf8', shell: false });
    assert.equal(cjsSyntax.status, 0, `${cjsSyntax.stdout}\n${cjsSyntax.stderr}`);

    const privateValue = 'agent-private-value-not-in-source';
    const runtimeToken = 'runtime-secret-not-in-source';
    for (const source of [fs.readFileSync(tsPath, 'utf8'), fs.readFileSync(esmPath, 'utf8'), fs.readFileSync(cjsPath, 'utf8')]) {
      assert.equal(source.includes(privateValue), false);
      assert.equal(source.includes(runtimeToken), false);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('guardedTransfer reports only after signing and never throws after submission', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-report-guard-'));
  const envKeys = ['ASGUARD_API_URL', 'ASGUARD_RUNTIME_TOKEN', 'ASGUARD_AGENT_ID', 'ASGUARD_AGENT_NAME', 'ASGUARD_NETWORK', 'ASGUARD_ATTESTATION_PUBLIC_KEY_PATH'];
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  const originalError = console.error;
  const shared = globalThis as typeof globalThis & { __asguardReports?: Array<Record<string, unknown>>; __asguardReportFailure?: boolean };
  try {
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
    fs.writeFileSync(path.join(directory, 'attestation.pem'), 'stub-public-key');
    fs.writeFileSync(path.join(directory, 'sdk.mjs'), `
      export function connectAgent() { return Promise.resolve({}); }
      export async function withAsguardApproval(_options, callback) { return callback({ attestation: { payload_hash: '${'a'.repeat(64)}' }, canonicalPayload: {}, decision: { intentId: 'intent-1' } }); }
      export async function reportSubmission(options) { globalThis.__asguardReports.push(options); if (globalThis.__asguardReportFailure) throw new Error('report failed'); }
    `);
    const guardPath = path.join(directory, 'asguard.guard.mjs');
    fs.writeFileSync(guardPath, buildGuardTemplate('js', 'relative', './sdk.mjs', 'esm'));
    const guard = await import(`${pathToFileURL(guardPath).href}?v=${Date.now()}`) as {
      guardedTransfer: (transfer: unknown, callback: (context: unknown) => Promise<unknown>, options?: { extractTxHash?: () => string | undefined; onReportError?: (error: unknown, hash: string | undefined) => void }) => Promise<unknown>;
    };
    Object.assign(process.env, {
      ASGUARD_API_URL: 'http://localhost:8080', ASGUARD_RUNTIME_TOKEN: 'x'.repeat(32), ASGUARD_AGENT_ID: 'agent-one',
      ASGUARD_AGENT_NAME: 'Agent One', ASGUARD_NETWORK: 'near:testnet', ASGUARD_ATTESTATION_PUBLIC_KEY_PATH: path.join(directory, 'attestation.pem'),
    });
    shared.__asguardReports = [];
    const outcome = { transaction: { hash: '1'.repeat(43) } };
    assert.equal(await guard.guardedTransfer({}, async () => outcome), outcome);
    assert.deepEqual(shared.__asguardReports[0], {
      baseUrl: 'http://localhost:8080', token: 'x'.repeat(32), intentId: 'intent-1', payloadHash: 'a'.repeat(64), txHash: outcome.transaction.hash,
    });

    let reportError: unknown;
    const logs: unknown[][] = [];
    console.error = (...values: unknown[]) => { logs.push(values); };
    shared.__asguardReportFailure = true;
    assert.equal(await guard.guardedTransfer({}, async () => outcome, { onReportError: (error, hash) => { reportError = { error, hash }; } }), outcome);
    assert.equal((reportError as { hash: string }).hash, outcome.transaction.hash);
    assert.equal(logs.length, 1);
    assert.equal(String(logs[0][0]).includes(outcome.transaction.hash), true);

    shared.__asguardReportFailure = false;
    await guard.guardedTransfer({}, async () => outcome, { extractTxHash: () => { throw new Error('extract failed'); } });
    const before = shared.__asguardReports.length;
    await assert.rejects(guard.guardedTransfer({}, async () => { throw new Error('sign failed'); }));
    assert.equal(shared.__asguardReports.length, before);
  } finally {
    console.error = originalError;
    delete shared.__asguardReports;
    delete shared.__asguardReportFailure;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
