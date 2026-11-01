import { spawn, type ChildProcess } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';

const backendArgs = ['--env-file=.env', '--import', 'tsx', '--watch', 'scripts/start-backend.ts'];
let backend: ChildProcess | undefined;
let watcher: FSWatcher | undefined;
let restartTimer: ReturnType<typeof setTimeout> | undefined;
let restartRequested = false;
let stopping = false;

function startBackend(): void {
  if (stopping) return;
  restartRequested = false;
  const backendEnv = { ...process.env };
  // For local development, .env is authoritative; inherited shell values can be stale.
  for (const name of Object.keys(backendEnv)) {
    if (name.startsWith('ASGUARD_')) delete backendEnv[name];
  }
  backend = spawn(process.execPath, backendArgs, {
    cwd: process.cwd(),
    env: backendEnv,
    stdio: 'inherit',
    windowsHide: true,
  });
  backend.on('error', (error) => {
    console.error(`[ASGUARD dev] Could not start backend: ${error.message}`);
  });
  backend.on('exit', () => {
    backend = undefined;
    if (restartRequested && !stopping) startBackend();
  });
}

function restartBackend(): void {
  if (stopping) return;
  restartRequested = true;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = undefined;
    if (!backend) {
      startBackend();
      return;
    }
    console.log('[ASGUARD dev] .env changed; restarting backend to reload configuration.');
    backend.kill();
  }, 250);
}

function stop(): void {
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  watcher?.close();
  if (backend) backend.kill();
  else process.exit(0);
}

try {
  watcher = watch(process.cwd(), (_eventType, filename) => {
    if (filename?.toString() === '.env') restartBackend();
  });
} catch (error) {
  console.error('[ASGUARD dev] Could not watch the project directory for .env changes.', error);
  process.exitCode = 1;
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
startBackend();
