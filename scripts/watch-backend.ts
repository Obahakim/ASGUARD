import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, unlinkSync, watch, writeSync, type FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const backendArgs = ['--env-file=.env', '--import', 'tsx', 'scripts/start-backend.ts'];
const workspaceKey = createHash('sha256').update(resolve(process.cwd()).toLowerCase()).digest('hex').slice(0, 16);
const lockPath = resolve(tmpdir(), `asguard-backend-${workspaceKey}.lock`);
let backend: ChildProcess | undefined;
const watchers: FSWatcher[] = [];
let restartTimer: ReturnType<typeof setTimeout> | undefined;
let restartRequested = false;
let stopping = false;

function acquireLock(): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let ownerPid = 0;
      try {
        ownerPid = Number(readFileSync(lockPath, 'utf8').trim());
      } catch {
        // A concurrently starting watcher may not have written its PID yet.
      }
      if (Number.isInteger(ownerPid) && ownerPid > 0) {
        try {
          process.kill(ownerPid, 0);
          console.log(`[ASGUARD dev] Backend watcher already running (PID ${ownerPid}); it owns this workspace's API.`);
          return false;
        } catch (probeError) {
          if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') {
            console.error('[ASGUARD dev] Another backend watcher owns this workspace lock.');
            return false;
          }
        }
      } else if (attempt === 0) {
        continue;
      } else {
        console.error('[ASGUARD dev] Another backend watcher is starting for this workspace.');
        return false;
      }
      try {
        unlinkSync(lockPath);
      } catch {
        console.error('[ASGUARD dev] Could not clear the stale backend watcher lock.');
        return false;
      }
    }
  }
  return false;
}

function releaseLock(): void {
  try {
    if (readFileSync(lockPath, 'utf8').trim() === String(process.pid)) unlinkSync(lockPath);
  } catch {
    // The lock may already have been removed during workspace cleanup.
  }
}

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
  backend.on('exit', (code) => {
    backend = undefined;
    if (restartRequested && !stopping) startBackend();
    else if (stopping) process.exit(0);
    else {
      console.error(`[ASGUARD dev] Backend exited unexpectedly (code ${code ?? 'unknown'}).`);
      process.exit(code || 1);
    }
  });
}

function restartBackend(reason: string): void {
  if (stopping) return;
  restartRequested = true;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = undefined;
    if (!backend) {
      startBackend();
      return;
    }
    console.log(`[ASGUARD dev] ${reason}; restarting backend.`);
    backend.kill();
  }, 250);
}

function stop(): void {
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  for (const watcher of watchers) watcher.close();
  if (backend) backend.kill();
  else process.exit(0);
}

try {
  watchers.push(watch(process.cwd(), (_eventType, filename) => {
    if (filename?.toString() === '.env') restartBackend('.env changed; reloading configuration');
  }));
  watchers.push(watch(join(process.cwd(), 'server'), { recursive: true }, () => {
    restartBackend('server source changed');
  }));
  watchers.push(watch(join(process.cwd(), 'scripts'), (_eventType, filename) => {
    if (filename?.toString() === 'start-backend.ts') restartBackend('backend startup code changed');
  }));
} catch (error) {
  console.error('[ASGUARD dev] Could not watch backend configuration and source files.', error);
  process.exitCode = 1;
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
if (acquireLock()) {
  process.once('exit', releaseLock);
  startBackend();
} else {
  process.exit(0);
}
