import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');

function findTests(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return findTests(filePath);
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [filePath] : [];
  });
}

const testFiles = ['server', 'agent-sdk']
  .flatMap((directory) => findTests(path.join(repositoryRoot, directory)))
  .map((filePath) => path.relative(repositoryRoot, filePath))
  .sort();
if (testFiles.length === 0) throw new Error('No server or agent-sdk test files were found.');

const result = spawnSync(process.execPath, [
  '--require', './scripts/test-preload.cjs',
  '--import', 'tsx',
  '--test',
  '--test-force-exit',
  ...testFiles,
], { cwd: repositoryRoot, stdio: 'inherit' });

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
