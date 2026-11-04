import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CHECKER_SOURCE } from './checkerTemplate';

function run(project: string, ...args: string[]) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', CHECKER_SOURCE, '--', '--project', project, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: false,
  });
}

test('scanner detects every rule family, skips comments, and guards nested callbacks and templates', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-scanner-'));
  try {
    fs.mkdirSync(path.join(project, 'node_modules'));
    fs.writeFileSync(path.join(project, 'node_modules', 'ignored.js'), 'wallet.sendMoney(1);');
    fs.writeFileSync(path.join(project, 'agent.ts'), [
      '// wallet.sendMoney(0);',
      'wallet.sendMoney(1); wallet.signAndSendTransaction(2); wallet.functionCall(3);',
      'wallet.addKey(4); wallet.deleteKey(5); wallet.deployContract(6); wallet.signTransaction(7);',
      'contract.v1.signer; provider.sendTransaction(8); provider.sendRawTransaction(9);',
      'signer.signMessage(10); signer.signTypedData(11); writeContract(12);',
      'KeyPair.fromString(value); const key = process.env.ASGUARD_PRIVATE_KEY; fromMnemonic(value);',
      `const leaked = 'ed25519:${'1'.repeat(40)}';`,
      'guardedTransfer(async () => {',
      '  const nested = guardedIntent(async () => { wallet.sendMoney(13); });',
      '  const template = `prefix ${(() => ") ) )")()} suffix`; wallet.signTransaction(14);',
      '});',
      '// asguard-allow: SIGN-NEAR documented exception',
      'wallet.sendMoney(15);',
      '// asguard-allow: SIGN-EVM',
      'writeContract(16);',
    ].join('\n'));

    const result = run(project, '--json', '--warn-only');
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as {
      findings: Array<{ rule: string; line: number }>;
      allowed: Array<{ rule: string; reason?: string }>;
      summary: { guarded: number; files_scanned: number };
    };
    for (const id of ['SIGN-NEAR', 'SIGN-CHAINSIG', 'SIGN-EVM', 'KEY-LOAD', 'KEY-LITERAL']) {
      assert.equal(report.findings.some((finding) => finding.rule === id), true, id);
    }
    assert.equal(report.findings.some((finding) => finding.line === 1), false);
    assert.equal(report.findings.some((finding) => finding.line === 10 || finding.line === 11), false);
    assert.equal(report.allowed.length, 1);
    assert.equal(report.allowed[0].reason, 'documented exception');
    assert.equal(report.summary.guarded >= 2, true);
    assert.equal(report.summary.files_scanned, 1);
    assert.equal(result.stdout.includes('1'.repeat(40)), false);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('KEY-LITERAL output contains only rule location and never matched key material', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-key-literal-'));
  const secret = `ed25519:${'2'.repeat(40)}`;
  try {
    fs.writeFileSync(path.join(project, 'agent.js'), `const key = '${secret}';\n`);
    const result = run(project);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /KEY-LITERAL/);
    assert.equal(result.stdout.includes(secret), false);
    assert.equal(result.stderr.includes(secret), false);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('one source line contributes only one finding per rule', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-dedupe-'));
  try {
    fs.writeFileSync(path.join(project, 'agent.ts'), 'KeyPair.fromString(process.env.ASGUARD_PRIVATE_KEY);\n');
    const result = run(project, '--json', '--warn-only');
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as { findings: Array<{ rule: string; line: number }> };
    assert.equal(report.findings.filter((finding) => finding.rule === 'KEY-LOAD' && finding.line === 1).length, 1);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('checker has expected exit codes, JSON shape, and no matched source text', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-checker-exits-'));
  try {
    fs.writeFileSync(path.join(project, 'clean.mjs'), 'export const value = 1;\n');
    assert.equal(run(project).status, 0);
    fs.writeFileSync(path.join(project, 'bad.js'), 'wallet.sendMoney(1);\n');
    assert.equal(run(project).status, 1);
    assert.equal(run(project, '--warn-only').status, 0);
    const json = run(project, '--json');
    assert.equal(json.status, 1);
    const parsed = JSON.parse(json.stdout) as { version: string; findings: Array<Record<string, unknown>>; summary: object };
    assert.equal(parsed.version, '1.0.0');
    assert.equal(JSON.stringify(parsed).includes('wallet.sendMoney'), false);
    assert.equal(run(path.join(project, 'missing')).status, 2);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
