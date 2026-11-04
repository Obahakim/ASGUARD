import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installCheckScript, updateProjectGitignore, writeCiWorkflow } from './projectSetup';

test('check script install preserves JSON fields, indentation, newline, and backup bytes', () => {
  for (const indent of ['  ', '    ', '\t']) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-package-script-'));
    try {
      const file = path.join(directory, 'package.json');
      const newline = indent === '\t' ? '\r\n' : '\n';
      const original = ['{', `${indent}"name": "agent",`, `${indent}"other": { "x": 1 }`, '}'].join(newline) + newline;
      fs.writeFileSync(file, original);
      assert.equal(installCheckScript(directory), 'installed');
      const saved = fs.readFileSync(file, 'utf8');
      assert.equal(saved.includes(newline), true);
      assert.equal(saved.endsWith(newline), true);
      assert.deepEqual(JSON.parse(saved), { name: 'agent', other: { x: 1 }, scripts: { 'asguard:check': 'node asguard-check.mjs' } });
      assert.equal(fs.readFileSync(`${file}.asguard-bak`, 'utf8'), original);
      assert.equal(installCheckScript(directory), 'installed');
      assert.equal(fs.readdirSync(directory).filter((name) => name.startsWith('package.json.asguard-bak')).length, 1);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
});

test('check script conflict is left untouched and absent package metadata is skipped', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-package-conflict-'));
  try {
    const file = path.join(directory, 'package.json');
    const original = '{"scripts":{"asguard:check":"custom"}}\n';
    fs.writeFileSync(file, original);
    assert.equal(installCheckScript(directory), 'conflict');
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal(installCheckScript(path.join(directory, 'missing')), 'skipped');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('gitignore is idempotent, preserves CRLF, and check-ignore verifies both entries', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-ignore-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: directory, shell: false }).status, 0);
    const file = path.join(directory, '.gitignore');
    fs.writeFileSync(file, 'existing\r\n');
    assert.equal(updateProjectGitignore(directory), true);
    assert.equal(updateProjectGitignore(directory), true);
    const saved = fs.readFileSync(file, 'utf8');
    assert.equal(saved, 'existing\r\n.env.asguard\r\n.asguard-backup/\r\n');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('CI workflow uses pinned actions, no secrets, and does not overwrite an existing workflow', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-ci-'));
  try {
    const output = writeCiWorkflow(directory, false);
    assert.ok(output);
    const workflow = fs.readFileSync(output, 'utf8');
    assert.match(workflow, /actions\/checkout@v4/);
    assert.match(workflow, /actions\/setup-node@v4/);
    assert.match(workflow, /node-version: 20/);
    assert.match(workflow, /contents: read/);
    assert.match(workflow, /pull_request:/);
    assert.equal(workflow.includes('secret'), false);
    assert.equal(writeCiWorkflow(directory, false), undefined);
    assert.ok(writeCiWorkflow(directory, true)?.endsWith('asguard-check.yml.new'));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
