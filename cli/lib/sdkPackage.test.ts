import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { buildGuardTemplate } from './guardTemplates';

test('built SDK package exports all public helpers from a clean temporary project', async (context) => {
  const repository = path.resolve(process.cwd());
  const packageRoot = path.join(repository, 'dist', 'sdk', 'agent-sdk');
  if (!fs.existsSync(path.join(packageRoot, 'index.js'))) {
    context.skip('Run npm run build:sdk to verify the emitted package tree.');
    console.log('SKIP package load test: npm run build:sdk has not been run.');
    return;
  }
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-sdk-package-'));
  try {
    const install = path.join(project, 'node_modules', 'asguard');
    fs.mkdirSync(install, { recursive: true });
    fs.copyFileSync(path.join(repository, 'package.json'), path.join(install, 'package.json'));
    fs.cpSync(path.join(repository, 'dist', 'sdk'), path.join(install, 'dist', 'sdk'), { recursive: true });
    const require = createRequire(path.join(project, 'package.json'));
    const sdkSpecifier = ['asguard', 'agent-sdk'].join('/');
    const sdk = require(sdkSpecifier) as Record<string, unknown>;
    for (const name of ['connectAgent', 'withAsguardApproval', 'reportSubmission']) assert.equal(typeof sdk[name], 'function', name);
    for (const pathName of ['server/endpointPolicy.js', 'server/aos/nearIntent.js', 'server/aos/nearTransfer.js', 'server/types.js']) {
      assert.equal(fs.existsSync(path.join(install, 'dist', 'sdk', pathName)), true, pathName);
    }
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ type: 'module' }));
    const guardPath = path.join(project, 'asguard.guard.mjs');
    fs.writeFileSync(guardPath, buildGuardTemplate('js', 'package', '', 'esm'));
    const guard = await import(pathToFileURL(guardPath).href) as { guardedTransfer?: unknown };
    assert.equal(typeof guard.guardedTransfer, 'function');
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});
