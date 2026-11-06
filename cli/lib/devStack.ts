import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readEnvFile } from './envFile';

const START_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 500;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const LOG_TAIL_BYTES = 4 * 1024;

export interface StackEndpoints {
  backendUrl: string;
  frontendUrl: string;
}

export interface StackReadiness {
  ready: boolean;
  backendReady: boolean;
  frontendReady: boolean;
  reason?: string;
}

export interface StackReadinessOptions {
  endpoints: StackEndpoints;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  pollIntervalMs?: number;
  isProcessAlive?: () => boolean;
}

export interface StartDevStackOptions {
  projectRoot?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  pollIntervalMs?: number;
  log?: (message: string) => void;
  launch?: (projectRoot: string, logPath: string) => Promise<number>;
  isProcessAlive?: (pid: number) => boolean;
  isPortAvailable?: (host: string, port: number) => Promise<boolean>;
}

export interface StopDevStackOptions {
  projectRoot?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  log?: (message: string) => void;
  isProcessAlive?: (pid: number) => boolean;
  killProcessTree?: (pid: number) => Promise<void>;
  platform?: NodeJS.Platform;
}

interface StackFiles {
  directory: string;
  pid: string;
  lock: string;
  log: string;
}

function stackFiles(projectRoot: string): StackFiles {
  const directory = path.join(projectRoot, '.asguard');
  return {
    directory,
    pid: path.join(directory, 'dev.pid'),
    lock: path.join(directory, 'dev.start.lock'),
    log: path.join(directory, 'dev.log'),
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      if (error.code === 'ESRCH') return false;
      if (error.code === 'EPERM') return true;
    }
    throw error;
  }
}

interface PidFile {
  pid: number;
  timestamp: string;
  backendPort: number;
  frontendPort: number;
}

function readPid(filePath: string): PidFile | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const value = fs.readFileSync(filePath, 'utf8').trim();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch {
    throw new Error(`Invalid process metadata in ${path.basename(filePath)}.`);
  }
  if (Number.isSafeInteger(parsed) && Number(parsed) > 0) parsed = { pid: Number(parsed) };
  if (!parsed || typeof parsed !== 'object' || !('pid' in parsed)
    || !Number.isSafeInteger(parsed.pid) || Number(parsed.pid) <= 0) {
    throw new Error(`Invalid process metadata in ${path.basename(filePath)}.`);
  }
  return parsed as PidFile;
}

function writePid(filePath: string, metadata: PidFile): void {
  const temporaryPath = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    throw error;
  }
}

function removePidIfOwned(filePath: string, pid: number): void {
  if (readPid(filePath)?.pid === pid) fs.unlinkSync(filePath);
}

function removeLockIfOwned(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const owner = readPid(filePath);
  if (owner?.pid === process.pid) fs.unlinkSync(filePath);
}

function acquireStartLock(filePath: string, checkAlive: (pid: number) => boolean): { acquired: boolean; ownerPid?: number } {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(filePath, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, `${process.pid}\n`, 'utf8');
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
      return { acquired: true };
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
      const ownerPid = readPid(filePath)?.pid;
      if (ownerPid === undefined || checkAlive(ownerPid)) return { acquired: false, ownerPid };
      fs.unlinkSync(filePath);
    }
  }
  return { acquired: false };
}

function portAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    server.listen(port, host, () => server.close((error) => error ? reject(error) : resolve(true)));
  });
}

function portFromUrl(value: string): number {
  const port = Number(new URL(value).port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid stack port in ${value}.`);
  return port;
}

function prepareLog(logPath: string): void {
  if (fs.existsSync(logPath) && fs.statSync(logPath).size > MAX_LOG_BYTES) fs.truncateSync(logPath, 0);
}

function redactLog(value: string): string {
  return value
    .replace(/(Authorization:\s*Bearer\s+)[^\s"'`]+/gi, '$1[REDACTED]')
    .replace(/((?:token|secret|private[_-]?key|audit[_-]?key)\s*[=:]\s*)["']?[^,\s"'`]+/gi, '$1[REDACTED]')
    .replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{20,}/g, '[REDACTED]');
}

function logTail(logPath: string): string {
  if (!fs.existsSync(logPath)) return '(no dev log was created)';
  const descriptor = fs.openSync(logPath, 'r');
  try {
    const size = fs.fstatSync(descriptor).size;
    const buffer = Buffer.alloc(Math.min(size, LOG_TAIL_BYTES));
    fs.readSync(descriptor, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    return redactLog(buffer.toString('utf8').trim() || '(dev log is empty)');
  } finally {
    fs.closeSync(descriptor);
  }
}

export function getStackEndpoints(projectRoot = process.cwd()): StackEndpoints {
  const env = readEnvFile(path.join(projectRoot, '.env'));
  const host = env.getValue('ASGUARD_HOST') || 'localhost';
  const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const backendPort = env.getValue('ASGUARD_PORT') || '8080';
  const frontendPort = process.env.PORT || '3000';
  return {
    backendUrl: `http://${formattedHost}:${backendPort}`,
    frontendUrl: `http://${formattedHost}:${frontendPort}`,
  };
}

async function endpointReady(url: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(1_500),
      redirect: 'manual',
    });
    return response.ok || response.status === 401 || response.status === 403;
  } catch {
    return false;
  }
}

export async function waitForStackReady(options: StackReadinessOptions): Promise<StackReadiness> {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs ?? START_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let backendReady = false;
  let frontendReady = false;

  do {
    if (options.isProcessAlive && !options.isProcessAlive()) {
      return { ready: false, backendReady, frontendReady, reason: 'stack process exited before readiness' };
    }
    [backendReady, frontendReady] = await Promise.all([
      endpointReady(new URL('/api/health', options.endpoints.backendUrl).toString(), fetchImpl),
      endpointReady(options.endpoints.frontendUrl, fetchImpl),
    ]);
    if (backendReady && frontendReady) return { ready: true, backendReady, frontendReady };
    if (Date.now() >= deadline) break;
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() <= deadline);

  const pending = [
    !backendReady ? `backend ${options.endpoints.backendUrl}` : undefined,
    !frontendReady ? `dashboard ${options.endpoints.frontendUrl}` : undefined,
  ].filter((value): value is string => value !== undefined).join(' and ');
  return { ready: false, backendReady, frontendReady, reason: `timed out waiting for ${pending}` };
}

async function launchBackgroundStack(projectRoot: string, logPath: string): Promise<number> {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath
    ? process.execPath
    : process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
  const args = npmExecPath
    ? [npmExecPath, 'run', 'dev']
    : process.platform === 'win32' ? ['/d', '/s', '/c', 'npm run dev'] : ['run', 'dev'];
  const descriptor = fs.openSync(logPath, 'a', 0o600);
  try {
    if (process.platform !== 'win32') fs.chmodSync(logPath, 0o600);
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }

  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd: projectRoot,
      detached: true,
      env: process.env,
      shell: false,
      stdio: ['ignore', descriptor, descriptor],
      windowsHide: true,
    });
    child.once('error', (error) => {
      if (!settled) {
        settled = true;
        fs.closeSync(descriptor);
        reject(error);
      }
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      fs.closeSync(descriptor);
      if (!child.pid) {
        reject(new Error('The ASGUARD dev process started without a process ID.'));
        return;
      }
      child.unref();
      resolve(child.pid);
    });
  });
}

export async function startDevStack(options: StartDevStackOptions = {}): Promise<boolean> {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const files = stackFiles(projectRoot);
  const log = options.log || console.log;
  const checkAlive = options.isProcessAlive || isProcessAlive;
  const endpoints = getStackEndpoints(projectRoot);
  fs.mkdirSync(files.directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(files.directory, 0o700);

  const existingPid = readPid(files.pid);
  if (existingPid !== undefined && checkAlive(existingPid.pid)) {
    const status = await waitForStackReady({
      endpoints, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs,
      pollIntervalMs: options.pollIntervalMs, isProcessAlive: () => checkAlive(existingPid.pid),
    });
    if (status.ready) {
      log(`READY: backend ${endpoints.backendUrl} · dashboard ${endpoints.frontendUrl} (already running, PID ${existingPid.pid})`);
      return true;
    }
    log(`ASGUARD dev process ${existingPid.pid} is already running but not ready: ${status.reason}.\n${logTail(files.log)}`);
    return false;
  }
  if (existingPid !== undefined) fs.unlinkSync(files.pid);

  const lock = acquireStartLock(files.lock, checkAlive);
  if (!lock.acquired) {
    if (lock.ownerPid && checkAlive(lock.ownerPid)) {
      const status = await waitForStackReady({
        endpoints, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs,
        pollIntervalMs: options.pollIntervalMs,
      });
      if (status.ready) {
        const pid = readPid(files.pid)?.pid;
        log(`READY: backend ${endpoints.backendUrl} · dashboard ${endpoints.frontendUrl}${pid ? ` (PID ${pid})` : ''}`);
        return true;
      }
      log(`Another ASGUARD start is in progress but not ready: ${status.reason}.`);
      return false;
    }
    log('Could not acquire the ASGUARD dev start lock.');
    return false;
  }

  try {
    const host = new URL(endpoints.backendUrl).hostname.replace(/^\[|\]$/g, '');
    const backendPort = portFromUrl(endpoints.backendUrl);
    const frontendPort = portFromUrl(endpoints.frontendUrl);
    const available = options.isPortAvailable || portAvailable;
    for (const [label, port] of [['backend', backendPort], ['dashboard', frontendPort]] as const) {
      if (!await available(host, port)) {
        log(`Cannot start ASGUARD: ${label} port ${port} is already in use.`);
        return false;
      }
    }
    prepareLog(files.log);
    log(`Starting ASGUARD; waiting up to ${Math.round((options.timeoutMs ?? START_TIMEOUT_MS) / 1000)} seconds for backend and dashboard readiness.`);
    const pid = await (options.launch || launchBackgroundStack)(projectRoot, files.log);
    try {
      writePid(files.pid, {
        pid,
        timestamp: new Date().toISOString(),
        backendPort,
        frontendPort,
      });
    } catch (error) {
      if (checkAlive(pid)) await terminateProcessTree(pid, checkAlive, process.platform);
      throw error;
    }
    const status = await waitForStackReady({
      endpoints, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs,
      pollIntervalMs: options.pollIntervalMs, isProcessAlive: () => checkAlive(pid),
    });
    if (!status.ready) {
      if (!checkAlive(pid)) removePidIfOwned(files.pid, pid);
      log(`ASGUARD dev stack is not ready: ${status.reason}.\nRecent log output (secrets redacted):\n${logTail(files.log)}`);
      return false;
    }
    log(`READY: backend ${endpoints.backendUrl} · dashboard ${endpoints.frontendUrl} (PID ${pid})`);
    return true;
  } finally {
    removeLockIfOwned(files.lock);
  }
}

function processGroupIsOwned(pid: number): boolean {
  const result = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
    encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) return false;
  return processGroupMatches(pid, Number(result.stdout.trim()));
}

export function processGroupMatches(pid: number, processGroupId: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0 && processGroupId === pid;
}

export function taskkillArguments(pid: number, force = false): string[] {
  return ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])];
}

async function terminateProcessTree(
  pid: number,
  checkAlive: (pid: number) => boolean,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform === 'win32') {
    const result = spawnSync('taskkill.exe', taskkillArguments(pid), {
      encoding: 'utf8', shell: false, stdio: ['ignore', 'ignore', 'pipe'],
    });
    if (result.error) throw result.error;
    if (result.status !== 0 && checkAlive(pid)) {
      throw new Error(result.stderr.trim() || `taskkill failed with exit code ${result.status}.`);
    }
    return;
  }
  if (!processGroupIsOwned(pid)) {
    if (checkAlive(pid)) throw new Error(`Cannot safely stop process ${pid}: its detached process group could not be verified.`);
    return;
  }
  process.kill(-pid, 'SIGTERM');
}

export async function stopDevStack(options: StopDevStackOptions = {}): Promise<boolean> {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const files = stackFiles(projectRoot);
  const log = options.log || console.log;
  const checkAlive = options.isProcessAlive || isProcessAlive;
  const metadata = readPid(files.pid);
  if (metadata === undefined) {
    if (fs.existsSync(files.lock)) {
      const ownerPid = readPid(files.lock)?.pid;
      if (ownerPid !== undefined && checkAlive(ownerPid)) {
        log(`ASGUARD dev stack startup is still in progress (setup PID ${ownerPid}); retry npm run stop shortly.`);
        return false;
      }
      fs.unlinkSync(files.lock);
    }
    log('ASGUARD dev stack is not running.');
    return true;
  }
  const pid = metadata.pid;
  if (!checkAlive(pid)) {
    removePidIfOwned(files.pid, pid);
    log(`Removed stale ASGUARD dev process file (PID ${pid}).`);
    return true;
  }

  const platform = options.platform || process.platform;
  await (options.killProcessTree || ((targetPid) => terminateProcessTree(targetPid, checkAlive, platform)))(pid);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  while (checkAlive(pid) && Date.now() < deadline) {
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
  if (checkAlive(pid)) {
    if (platform === 'win32') {
      const result = spawnSync('taskkill.exe', taskkillArguments(pid, true), {
        encoding: 'utf8', shell: false, stdio: ['ignore', 'ignore', 'pipe'],
      });
      if (result.error) throw result.error;
      if (result.status !== 0 && checkAlive(pid)) {
        throw new Error(result.stderr.trim() || `taskkill failed with exit code ${result.status}.`);
      }
    } else {
      if (!processGroupIsOwned(pid)) {
        if (checkAlive(pid)) throw new Error(`Cannot safely escalate shutdown for process ${pid}: its detached process group could not be verified.`);
      } else {
        process.kill(-pid, 'SIGKILL');
      }
    }
    const escalationDeadline = Date.now() + timeoutMs;
    while (checkAlive(pid) && Date.now() < escalationDeadline) {
      await delay(Math.min(pollIntervalMs, Math.max(0, escalationDeadline - Date.now())));
    }
    if (checkAlive(pid)) {
      log(`ASGUARD dev process ${pid} did not stop after SIGKILL/taskkill escalation.`);
      return false;
    }
  }
  removePidIfOwned(files.pid, pid);
  log(`Stopped ASGUARD dev stack (PID ${pid}).`);
  return true;
}

export function canOpenBrowser(
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return platform === 'win32' || platform === 'darwin'
    || Boolean(environment.DISPLAY || environment.WAYLAND_DISPLAY);
}

export async function openDashboard(): Promise<boolean> {
  if (!canOpenBrowser()) return false;
  const url = 'http://localhost:3000';
  const command = process.platform === 'win32'
    ? (process.env.ComSpec || 'cmd.exe')
    : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', `start "" "${url}"`]
    : [url];
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, args, { stdio: 'ignore', detached: true, shell: false, windowsHide: true });
    child.once('error', () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve(true);
    });
  });
}
