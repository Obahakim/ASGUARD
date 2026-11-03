import { spawnSync } from 'node:child_process';

export function copyToClipboard(value: string): boolean {
  const platform = process.platform;
  const command = platform === 'win32' ? 'clip' : platform === 'darwin' ? 'pbcopy' : 'xclip';
  const args = platform === 'linux' ? ['-selection', 'clipboard'] : [];
  const result = spawnSync(command, args, {
    input: value,
    encoding: 'utf8',
    shell: false,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  return !result.error && result.status === 0;
}
