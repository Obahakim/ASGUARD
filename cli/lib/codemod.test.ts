import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { transformSource, applySendMoneyGuard } from './codemod';

test('transforms only simple near-api-js sendMoney calls and preserves the outcome', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-codemod-transform-'));
  try {
    const file = path.join(project, 'nested', 'agent.ts');
    fs.mkdirSync(path.dirname(file));
    const original = "import { connect } from 'near-api-js';\nconst outcome = await acct.sendMoney(receiver, amount);\n";
    const transformed = transformSource(file, project, path.join(project, 'asguard.guard.ts'), original);
    assert.deepEqual(transformed.matches, [{ file: 'nested/agent.ts', line: 2 }]);
    assert.equal(transformed.output, "import { connect } from 'near-api-js';\nimport { guardedTransfer } from '../asguard.guard';\nconst outcome = await guardedTransfer({ sender: acct.accountId, receiver: receiver, amount: String(amount) }, () => acct.sendMoney(receiver, amount));\n");
    assert.equal(transformSource(file, project, path.join(project, 'asguard.guard.ts'), transformed.output).output, transformed.output);
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test('preserves file flavor, shebang, use strict, existing imports, and NodeNext specifiers', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-codemod-imports-'));
  try {
    fs.writeFileSync(path.join(project, 'tsconfig.json'), '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"}}');
    const tsFile = path.join(project, 'agent.ts');
    const tsOutput = transformSource(tsFile, project, path.join(project, 'asguard.guard.ts'), "import 'near-api-js';\nawait acct.sendMoney('alice', 1n);\n").output;
    assert.match(tsOutput, /from '\.\/asguard\.guard\.js'/);
    const cjs = transformSource(path.join(project, 'agent.cjs'), project, path.join(project, 'asguard.guard.js'), "#!/usr/bin/env node\n'use strict';\nconst near = require('near-api-js');\nawait acct.sendMoney('alice', 1n);\n").output;
    assert.match(cjs, /'use strict';\nconst near = require\('near-api-js'\);\nconst \{ guardedTransfer \}/);
    assert.match(cjs, /const \{ guardedTransfer \} = require\('\.\/asguard\.guard'\);/);
    const duplicate = transformSource(tsFile, project, path.join(project, 'asguard.guard.ts'), "import { guardedTransfer } from './asguard.guard';\nimport 'near-api-js';\nawait acct.sendMoney('alice', 1n);\n").output;
    assert.equal((duplicate.match(/guardedTransfer.*from/g) || []).length, 1);
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test('does not transform impure arguments, unrelated modules, or already guarded calls', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-codemod-skip-'));
  try {
    for (const expression of ['foo()', 'await foo()', '...values']) {
      const source = `import 'near-api-js';\nawait acct.sendMoney(${expression}, amount);\n`;
      assert.equal(transformSource(path.join(project, 'agent.ts'), project, path.join(project, 'asguard.guard.ts'), source).matches.length, 0);
    }
    assert.equal(transformSource(path.join(project, 'agent.ts'), project, path.join(project, 'asguard.guard.ts'), "import 'other';\nawait acct.sendMoney('alice', 1n);\n").skipped[0].reason, 'skipped: no near-api-js import (possibly unrelated sendMoney method)');
    const guarded = "import 'near-api-js';\nguardedTransfer(transfer, async () => await acct.sendMoney('alice', 1n));\n";
    assert.equal(transformSource(path.join(project, 'agent.ts'), project, path.join(project, 'asguard.guard.ts'), guarded).matches.length, 0);
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test('--patch writes an applicable diff without modifying source; dirty files are refused', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-codemod-apply-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: project, shell: false }).status, 0);
    const file = path.join(project, 'agent.ts');
    const original = "import 'near-api-js';\nawait acct.sendMoney('alice', 1n);\n";
    fs.writeFileSync(file, original);
    const guard = path.join(project, 'asguard.guard.ts');
    fs.writeFileSync(guard, 'export function guardedTransfer() {}\n');
    spawnSync('git', ['add', 'agent.ts', 'asguard.guard.ts'], { cwd: project, shell: false });
    spawnSync('git', ['-c', 'user.name=ASGUARD Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: project, shell: false });
    const patchPath = path.join(project, 'review.patch');
    const patch = await applySendMoneyGuard({ project, guardPath: guard, yes: true, apply: false, forceNoGit: false, patchPath });
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.ok(patch.patch);
    assert.equal(spawnSync('git', ['apply', '--check', patchPath], { cwd: project, shell: false }).status, 0);
    const changed = await applySendMoneyGuard({ project, guardPath: guard, yes: true, apply: true, forceNoGit: false });
    assert.equal(changed.applied.length, 1);
    const backupDirectories = fs.readdirSync(path.join(project, '.asguard-backup'));
    assert.equal(backupDirectories.length, 1);
    assert.equal(fs.readFileSync(path.join(project, '.asguard-backup', backupDirectories[0], 'agent.ts'), 'utf8'), original);
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test('apply requires git unless overridden and refuses dirty target files', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-codemod-gates-'));
  try {
    const file = path.join(project, 'agent.ts');
    const source = "import 'near-api-js';\nawait acct.sendMoney('alice', 1n);\n";
    fs.writeFileSync(file, source);
    const guard = path.join(project, 'asguard.guard.ts');
    fs.writeFileSync(guard, 'export function guardedTransfer() {}\n');
    const refused = await applySendMoneyGuard({ project, guardPath: guard, yes: true, apply: true, forceNoGit: false, printDiff: false });
    assert.match(refused.notes.join(' '), /not a git repository/);
    assert.equal(fs.readFileSync(file, 'utf8'), source);
    assert.equal(fs.existsSync(path.join(project, '.asguard-backup')), false);

    assert.equal(spawnSync('git', ['init', '-q'], { cwd: project, shell: false }).status, 0);
    spawnSync('git', ['add', 'agent.ts', 'asguard.guard.ts'], { cwd: project, shell: false });
    spawnSync('git', ['-c', 'user.name=ASGUARD Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: project, shell: false });
    fs.writeFileSync(file, source + '// dirty\n');
    const dirty = await applySendMoneyGuard({ project, guardPath: guard, yes: true, apply: true, forceNoGit: false, printDiff: false });
    assert.match(dirty.notes.join(' '), /dirty file/);
    assert.equal(fs.existsSync(path.join(project, '.asguard-backup')), false);
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});
