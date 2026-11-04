import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export type ScriptInstallStatus = 'installed' | 'conflict' | 'skipped';

function backup(filePath: string): void {
  const exact = `${filePath}.asguard-bak`;
  let destination = exact;
  if (fs.existsSync(destination)) {
    const epoch = Math.floor(Date.now() / 1000);
    destination = `${exact}.${epoch}`;
    let suffix = 1;
    while (fs.existsSync(destination)) destination = `${exact}.${epoch}.${suffix++}`;
  }
  fs.copyFileSync(filePath, destination, fs.constants.COPYFILE_EXCL);
}

function findObjectEnd(source: string, open: number): number {
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
    } else if (character === '"') quote = character;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return index;
  }
  throw new Error('package.json contains an unbalanced object.');
}

function addProperty(source: string, open: number, key: string, value: string, indent: string, newline: string): string {
  const close = findObjectEnd(source, open);
  const interior = source.slice(open + 1, close);
  const trimmed = interior.trimEnd();
  const indentAtOpen = source.slice(0, open).match(/(?:^|\r?\n)([ \t]*)[^\r\n]*$/)?.[1] ?? '';
  const childIndent = indentAtOpen + indent;
  const content = trimmed.trim();
  const comma = content && !content.endsWith(',') ? ',' : '';
  const insertion = `${comma}${newline}${childIndent}${JSON.stringify(key)}: ${JSON.stringify(value)}${newline}${indentAtOpen}`;
  return source.slice(0, close) + insertion + source.slice(close);
}

export function installCheckScript(project: string): ScriptInstallStatus {
  const filePath = path.join(project, 'package.json');
  if (!fs.existsSync(filePath)) return 'skipped';
  const original = fs.readFileSync(filePath, 'utf8');
  const pkg = JSON.parse(original) as { scripts?: Record<string, unknown> };
  const current = pkg.scripts?.['asguard:check'];
  if (current === 'node asguard-check.mjs') return 'installed';
  if (current !== undefined) return 'conflict';
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const indent = original.match(/\r?\n([ \t]+)"/)?.[1] ?? '  ';
  let updated = original;
  const scriptsKey = /"scripts"\s*:\s*\{/g.exec(original);
  if (scriptsKey) {
    const open = original.indexOf('{', scriptsKey.index);
    updated = addProperty(original, open, 'asguard:check', 'node asguard-check.mjs', indent, newline);
  } else {
    const rootOpen = original.indexOf('{');
    updated = addProperty(original, rootOpen, 'scripts', '{', indent, newline);
    const insertedAt = updated.indexOf('"scripts": "{"');
    if (insertedAt >= 0) updated = updated.slice(0, insertedAt) + '"scripts": {' + newline + indent + JSON.stringify('asguard:check') + ': ' + JSON.stringify('node asguard-check.mjs') + newline + indent.slice(0, -1) + '}' + updated.slice(insertedAt + '"scripts": "{"'.length);
  }
  if (original.endsWith('\n') && !updated.endsWith('\n')) updated += newline;
  backup(filePath);
  const temp = `${filePath}.asguard-tmp-${process.pid}`;
  fs.writeFileSync(temp, updated, { flag: 'wx' });
  fs.renameSync(temp, filePath);
  return 'installed';
}

export function updateProjectGitignore(project: string): boolean {
  const git = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: project, encoding: 'utf8', shell: false, stdio: 'ignore' });
  if (git.status !== 0) return false;
  const filePath = path.join(project, '.gitignore');
  const original = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  const additions = ['.env.asguard', '.asguard-backup/'].filter((item) => !lines.includes(item));
  if (additions.length) {
    const prefix = original && !original.endsWith('\n') ? newline : '';
    fs.appendFileSync(filePath, prefix + additions.join(newline) + newline);
  }
  const checks = ['.env.asguard', '.asguard-backup/'].map((item) => spawnSync('git', ['check-ignore', '-q', item], { cwd: project, shell: false, stdio: 'ignore' }));
  if (checks.some((result) => result.status !== 0)) throw new Error('git check-ignore did not confirm ASGUARD local files are ignored.');
  return true;
}

export function writeCiWorkflow(project: string, forceNew: boolean): string | undefined {
  const directory = path.join(project, '.github', 'workflows');
  const target = path.join(directory, 'asguard-check.yml');
  const output = fs.existsSync(target) ? (forceNew ? `${target}.new` : undefined) : target;
  if (!output) return undefined;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(output, `name: ASGUARD check\non:\n  push:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n      - run: node asguard-check.mjs\n`, { flag: 'wx' });
  return output;
}
