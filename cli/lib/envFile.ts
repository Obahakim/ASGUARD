import fs from 'node:fs';
import path from 'node:path';

type EnvLine = { key: string; value: string } | { raw: string };

export class EnvFile {
  private constructor(private readonly lines: EnvLine[]) {}

  static parse(contents: string): EnvFile {
    if (!contents) return new EnvFile([]);
    const lines = contents.split(/\r?\n/).map((raw): EnvLine => {
      const match = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) return { raw };
      let value = match[2];
      if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        value = value.slice(1, -1).replace(/\\(["\\])/g, '$1');
      }
      return { key: match[1], value };
    });
    if (contents.endsWith('\n')) lines.pop();
    return new EnvFile(lines);
  }

  getValue(key: string): string | undefined {
    const line = this.lines.find((candidate): candidate is Extract<EnvLine, { key: string }> =>
      'key' in candidate && candidate.key === key);
    return line?.value;
  }

  setValue(key: string, value: string): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Invalid environment variable name.');
    if (/[\n\r\0]/.test(value)) throw new Error(`Environment value for ${key} contains a forbidden line break or NUL.`);
    const existing = this.lines.find((line): line is Extract<EnvLine, { key: string }> =>
      'key' in line && line.key === key);
    if (existing) existing.value = value;
    else this.lines.push({ key, value });
  }

  serialize(): string {
    return this.lines.map((line) => 'key' in line
      ? `${line.key}=${encodeValue(line.key, line.value)}`
      : line.raw).join('\n') + '\n';
  }
}

function encodeValue(key: string, value: string): string {
  if (key === 'ASGUARD_API_CREDENTIALS') return value;
  return /[\s#]/.test(value) ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : value;
}

export function isUnsetValue(value: string | undefined): boolean {
  return value === undefined || value.trim() === '' || value.startsWith('REPLACE_WITH');
}

export function readEnvFile(filePath: string): EnvFile {
  return EnvFile.parse(fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '');
}

export function writeEnvFile(filePath: string, env: EnvFile): boolean {
  const contents = env.serialize();
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === contents) {
    if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
    return false;
  }
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  if (fs.existsSync(filePath)) createBackup(filePath);
  const temporary = path.join(directory, `.env.tmp-${process.pid}`);
  let descriptor: number | undefined;
  let temporaryCreated = false;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    temporaryCreated = true;
    fs.writeFileSync(descriptor, contents, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
    temporaryCreated = false;
    if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
    return true;
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (temporaryCreated && fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
}

function createBackup(filePath: string): string {
  let backupPath = `${filePath}.bak`;
  if (fs.existsSync(backupPath)) {
    const epoch = Math.floor(Date.now() / 1000);
    backupPath = `${filePath}.bak.${epoch}`;
    let suffix = 1;
    while (fs.existsSync(backupPath)) {
      backupPath = `${filePath}.bak.${epoch}.${suffix}`;
      suffix += 1;
    }
  }
  fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
  if (process.platform !== 'win32') fs.chmodSync(backupPath, 0o600);
  return backupPath;
}
