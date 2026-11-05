import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { Prompter } from './prompt';

export interface SetupActionOptions {
  interactiveTTY: boolean;
  yes: boolean;
  check: boolean;
  prompter: Pick<Prompter, 'confirm'>;
  log?: (message: string) => void;
  startDevStack?: () => Promise<boolean>;
  openDashboard?: () => Promise<boolean>;
}

export function shouldOfferSetupActions(options: Pick<SetupActionOptions, 'interactiveTTY' | 'yes' | 'check'>): boolean {
  return options.interactiveTTY && !options.yes && !options.check;
}

export function startDevStack(): Promise<boolean> {
  return new Promise((resolve) => {
    const npmExecPath = process.env.npm_execpath;
    const command = npmExecPath ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
    const args = npmExecPath ? [npmExecPath, 'run', 'dev'] : ['run', 'dev'];
    let settled = false;
    const child = spawn(command, args, { cwd: process.cwd(), stdio: ['ignore', 'inherit', 'inherit'], shell: false });
    child.once('spawn', () => { settled = true; resolve(true); });
    child.once('error', () => { if (!settled) resolve(false); });
  });
}

export async function openDashboard(): Promise<boolean> {
  await delay(1_200);
  const url = 'http://localhost:3000';
  const platform = process.platform;
  const command = platform === 'win32' ? 'cmd.exe' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['/d', '/s', '/c', 'start', '""', url] : [url];
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, args, { stdio: 'ignore', detached: true, shell: false });
    child.once('spawn', () => { settled = true; child.unref(); resolve(true); });
    child.once('error', () => { if (!settled) resolve(false); });
  });
}

export async function offerPostSetupActions(options: SetupActionOptions): Promise<void> {
  if (!shouldOfferSetupActions(options)) return;
  const log = options.log || console.log;
  log('Next steps: npm run dev starts the backend at :8080 and dashboard at :3000. Your dashboard token is in .asguard/dashboard-token.txt.');
  if (!await options.prompter.confirm('Start ASGUARD now with npm run dev (backend :8080 + frontend :3000)?', true)) {
    log('Setup complete. Start later with: npm run dev');
    return;
  }
  if (!await (options.startDevStack || startDevStack)()) {
    log('Could not start the dev stack. Start it manually with: npm run dev');
    return;
  }
  log('ASGUARD dev stack start requested successfully. Backend http://localhost:8080 · Dashboard http://localhost:3000');
  log('Use the dashboard token from .asguard/dashboard-token.txt to sign in.');
  if (await options.prompter.confirm('Open the dashboard in your browser?', true)
    && !await (options.openDashboard || openDashboard)()) {
    log('Open manually: http://localhost:3000');
  }
}
