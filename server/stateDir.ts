import os from 'node:os';
import path from 'node:path';

const repositoryRoot = path.resolve(__dirname, '..');

export function resolveStatePath(fileName: string, specificEnvVar?: string): string {
  const specificPath = specificEnvVar ? process.env[specificEnvVar] : undefined;
  if (specificPath?.trim()) return specificPath;

  const stateDir = process.env.ASGUARD_STATE_DIR;
  if (stateDir?.trim()) {
    const resolvedStateDir = path.isAbsolute(stateDir)
      ? stateDir
      : path.resolve(repositoryRoot, stateDir);
    return path.join(resolvedStateDir, fileName);
  }

  return path.join(os.homedir(), '.asguard', fileName);
}
