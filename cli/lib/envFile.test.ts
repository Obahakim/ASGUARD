import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EnvFile, isUnsetValue, writeEnvFile } from './envFile';

test('preserves comments, blank lines, ordering, and unknown keys while editing', () => {
  const env = EnvFile.parse('# heading\nFIRST=one\n\nUNKNOWN=value\nSECOND=two\n');
  env.setValue('SECOND', 'updated value');
  env.setValue('THIRD', 'end');
  assert.equal(env.serialize(), '# heading\nFIRST=one\n\nUNKNOWN=value\nSECOND="updated value"\nTHIRD=end\n');
});

test('quotes whitespace and hash values with escapes but keeps credentials compact and unquoted', () => {
  const env = EnvFile.parse('');
  env.setValue('SPACE', 'a b');
  env.setValue('HASH', 'a#b');
  env.setValue('ESCAPES', 'a"b\\c d');
  env.setValue('ASGUARD_API_CREDENTIALS', '[{"id":"x","token":"y"}]');
  assert.equal(env.serialize(), 'SPACE="a b"\nHASH="a#b"\nESCAPES="a\\"b\\\\c d"\nASGUARD_API_CREDENTIALS=[{"id":"x","token":"y"}]\n');
  assert.equal(EnvFile.parse(env.serialize()).getValue('ESCAPES'), 'a"b\\c d');
});

test('rejects line breaks and NUL and treats empty and REPLACE_WITH values as unset', () => {
  const env = EnvFile.parse('');
  for (const value of ['line\nbreak', 'line\rbreak', 'nul\0value']) assert.throws(() => env.setValue('KEY', value), /forbidden/);
  assert.equal(isUnsetValue(undefined), true);
  assert.equal(isUnsetValue(''), true);
  assert.equal(isUnsetValue('REPLACE_WITH_RANDOM'), true);
  assert.equal(isUnsetValue(' valid '), false);
});

test('writes atomically, is idempotent, creates private backups, and does not overwrite backups', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-env-'));
  try {
    const file = path.join(directory, '.env');
    const env = EnvFile.parse('A=one\n');
    assert.equal(writeEnvFile(file, env), true);
    const stat = fs.statSync(file);
    if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(writeEnvFile(file, env), false);
    assert.equal(fs.statSync(file).mtimeMs, stat.mtimeMs);

    fs.writeFileSync(file, 'A=old\n');
    writeEnvFile(file, EnvFile.parse('A=two\n'));
    assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), 'A=old\n');
    fs.writeFileSync(file, 'A=older\n');
    writeEnvFile(file, EnvFile.parse('A=three\n'));
    assert.equal(fs.readdirSync(directory).filter((name) => name.startsWith('.env.bak')).length, 2);
    assert.equal(fs.readdirSync(directory).some((name) => name.startsWith('.env.tmp-')), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('removes a temporary file after an atomic rename failure', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-env-error-'));
  try {
    context.mock.method(fs, 'renameSync', () => { throw new Error('simulated rename failure'); });
    const file = path.join(directory, '.env');
    assert.throws(() => writeEnvFile(file, EnvFile.parse('A=value\n')));
    assert.equal(fs.readdirSync(directory).some((name) => name.startsWith('.env.tmp-')), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('does not remove another process temporary file when exclusive create fails', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-env-exclusive-'));
  try {
    const temporary = path.join(directory, `.env.tmp-${process.pid}`);
    fs.writeFileSync(temporary, 'another writer');
    assert.throws(() => writeEnvFile(path.join(directory, '.env'), EnvFile.parse('A=value\n')));
    assert.equal(fs.readFileSync(temporary, 'utf8'), 'another writer');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
