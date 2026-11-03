import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
