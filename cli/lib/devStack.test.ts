import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canOpenBrowser,
  getStackEndpoints,
  processGroupMatches,
  startDevStack,
  stopDevStack,
  taskkillArguments,
  waitForStackReady,
} from './devStack';

function temporaryProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-dev-stack-'));
}

test('stack endpoints use configured backend port and the frontend port', () => {
  const project = temporaryProject();
  const priorPort = process.env.PORT;
  try {
    delete process.env.PORT;
    fs.writeFileSync(path.join(project, '.env'), 'ASGUARD_HOST=127.0.0.1\nASGUARD_PORT=8181\n');
    assert.deepEqual(getStackEndpoints(project), {
      backendUrl: 'http://127.0.0.1:8181',
      frontendUrl: 'http://127.0.0.1:3000',
    });
  } finally {
    if (priorPort === undefined) delete process.env.PORT;
    else process.env.PORT = priorPort;
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('readiness requires both services and accepts auth responses from the protected API', async () => {
  const requested: string[] = [];
  const result = await waitForStackReady({
    endpoints: { backendUrl: 'http://localhost:8080', frontendUrl: 'http://localhost:3000' },
    fetchImpl: async (input) => {
      const url = String(input);
      requested.push(url);
      return new Response(null, { status: url.endsWith('/api/health') ? 401 : 200 });
    },
    timeoutMs: 100,
    pollIntervalMs: 1,
  });
  assert.deepEqual(result, { ready: true, backendReady: true, frontendReady: true });
  assert.deepEqual(requested.sort(), ['http://localhost:3000', 'http://localhost:8080/api/health']);
});

test('readiness reports missing services and exits early when the stack dies', async () => {
  const endpoints = { backendUrl: 'http://localhost:8080', frontendUrl: 'http://localhost:3000' };
  const unavailable = await waitForStackReady({
    endpoints,
    fetchImpl: async () => new Response(null, { status: 503 }),
    timeoutMs: 5,
    pollIntervalMs: 1,
  });
  assert.equal(unavailable.ready, false);
  assert.equal(unavailable.backendReady, false);
  assert.equal(unavailable.frontendReady, false);
  assert.match(unavailable.reason || '', /backend .* and dashboard/);

  const exited = await waitForStackReady({
    endpoints,
    isProcessAlive: () => false,
    fetchImpl: async () => { throw new Error('must not fetch after process exit'); },
  });
  assert.equal(exited.reason, 'stack process exited before readiness');
});

test('start is idempotent, writes a private PID file, and stop removes it after termination', async () => {
  const project = temporaryProject();
  const lines: string[] = [];
  let launches = 0;
  let alive = true;
  const options = {
    projectRoot: project,
    fetchImpl: async () => new Response(null, { status: 200 }),
    timeoutMs: 100,
    pollIntervalMs: 1,
    log: (message: string) => lines.push(message),
    launch: async () => { launches += 1; return 43_210; },
    isProcessAlive: (pid: number) => pid === 43_210 && alive,
    isPortAvailable: async () => true,
  };
  try {
    assert.equal(await startDevStack(options), true);
    const pidPath = path.join(project, '.asguard', 'dev.pid');
    const metadata = JSON.parse(fs.readFileSync(pidPath, 'utf8')) as { pid: number; timestamp: string; backendPort: number; frontendPort: number };
    assert.deepEqual({ ...metadata, timestamp: undefined }, {
      pid: 43_210, timestamp: undefined, backendPort: 8080, frontendPort: 3000,
    });
    assert.doesNotThrow(() => new Date(metadata.timestamp).toISOString());
    if (process.platform !== 'win32') assert.equal(fs.statSync(pidPath).mode & 0o777, 0o600);
    assert.equal(lines.some((line) => line.startsWith('READY:')), true);
    if (process.platform === 'win32') {
      assert.equal(lines.some((line) => line.includes('separate PowerShell window') && line.includes('.asguard\\dev.log')), true);
    }
    assert.equal(await startDevStack({ ...options, launch: async () => { throw new Error('duplicate start'); } }), true);
    assert.equal(launches, 1);

    const stopped = await stopDevStack({
      projectRoot: project,
      isProcessAlive: () => alive,
      killProcessTree: async (pid) => {
        assert.equal(pid, 43_210);
        alive = false;
      },
      log: (message) => lines.push(message),
    });
    assert.equal(stopped, true);
    assert.equal(fs.existsSync(pidPath), false);
    assert.equal(lines.some((line) => line.includes('Stopped ASGUARD dev stack')), true);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('stale PID files are replaced and failed launches leave no startup lock', async () => {
  const project = temporaryProject();
  const failedProject = temporaryProject();
  const directory = path.join(project, '.asguard');
  fs.mkdirSync(directory);
  const pidPath = path.join(directory, 'dev.pid');
  const lockPath = path.join(directory, 'dev.start.lock');
  fs.writeFileSync(pidPath, '12345\n');
  try {
    const started = await startDevStack({
      projectRoot: project,
      isProcessAlive: (pid) => pid !== 12345 && pid === 43_211,
      launch: async () => 43_211,
      fetchImpl: async () => new Response(null, { status: 200 }),
      timeoutMs: 100,
      pollIntervalMs: 1,
      log: () => undefined,
      isPortAvailable: async () => true,
    });
    assert.equal(started, true);
    assert.equal((JSON.parse(fs.readFileSync(pidPath, 'utf8')) as { pid: number }).pid, 43_211);
    assert.equal(fs.existsSync(lockPath), false);

    await assert.rejects(startDevStack({
      projectRoot: failedProject,
      launch: async () => { throw new Error('launch failed'); },
      isProcessAlive: () => false,
      log: () => undefined,
      isPortAvailable: async () => true,
    }), /launch failed/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(failedProject, { recursive: true, force: true });
  }
});

test('startup checks ports before launch and leaves the existing service untouched', async () => {
  const project = temporaryProject();
  let launches = 0;
  const messages: string[] = [];
  try {
    const started = await startDevStack({
      projectRoot: project,
      isPortAvailable: async (_host, port) => port !== 8080,
      launch: async () => { launches += 1; return 43_213; },
      log: (message) => messages.push(message),
    });
    assert.equal(started, false);
    assert.equal(launches, 0);
    assert.ok(messages.some((message) => message.includes('backend port 8080 is already in use')));
    assert.equal(fs.existsSync(path.join(project, '.asguard', 'dev.pid')), false);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('oversized logs are truncated and failure tails redact credentials', async () => {
  const project = temporaryProject();
  const logPath = path.join(project, '.asguard', 'dev.log');
  const messages: string[] = [];
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, 'x'.repeat(5 * 1024 * 1024 + 1));
    const started = await startDevStack({
      projectRoot: project,
      launch: async (_root, targetLog) => {
        fs.writeFileSync(targetLog, 'Authorization: Bearer verysecret\\nASGUARD_AUDIT_KEY=othersecret');
        return 43_214;
      },
      isProcessAlive: () => true,
      isPortAvailable: async () => true,
      fetchImpl: async () => new Response(null, { status: 503 }),
      timeoutMs: 1,
      pollIntervalMs: 1,
      log: (message) => messages.push(message),
    });
    assert.equal(started, false);
    const output = messages.join('\\n');
    assert.ok(!output.includes('verysecret'));
    assert.ok(!output.includes('othersecret'));
    assert.ok(output.includes('[REDACTED]'));
    assert.ok(fs.statSync(logPath).size < 1024);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('timed-out starts remain tracked for safe shutdown and stale stops clean up the PID file', async () => {
  const project = temporaryProject();
  const pidPath = path.join(project, '.asguard', 'dev.pid');
  const alive = true;
  try {
    const started = await startDevStack({
      projectRoot: project,
      launch: async () => 43_212,
      isProcessAlive: () => alive,
      fetchImpl: async () => new Response(null, { status: 503 }),
      timeoutMs: 2,
      pollIntervalMs: 1,
      log: () => undefined,
      isPortAvailable: async () => true,
    });
    assert.equal(started, false);
    assert.equal((JSON.parse(fs.readFileSync(pidPath, 'utf8')) as { pid: number }).pid, 43_212);

    const stopped = await stopDevStack({
      projectRoot: project,
      isProcessAlive: () => false,
      log: () => undefined,
    });
    assert.equal(stopped, true);
    assert.equal(fs.existsSync(pidPath), false);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('browser availability is limited to graphical or native desktop platforms', () => {
  assert.equal(canOpenBrowser('linux', {}), false);
  assert.equal(canOpenBrowser('linux', { DISPLAY: ':0' }), true);
  assert.equal(canOpenBrowser('linux', { WAYLAND_DISPLAY: 'wayland-0' }), true);
  assert.equal(canOpenBrowser('win32', {}), true);
  assert.equal(canOpenBrowser('darwin', {}), true);
});

test('Windows taskkill targets the recorded process tree and adds force only for escalation', () => {
  assert.deepEqual(taskkillArguments(4321), ['/PID', '4321', '/T']);
  assert.deepEqual(taskkillArguments(4321, true), ['/PID', '4321', '/T', '/F']);
});

test('POSIX process-group termination is allowed only for a group owned by the recorded PID', () => {
  assert.equal(processGroupMatches(4321, 4321), true);
  assert.equal(processGroupMatches(4321, 4322), false);
  assert.equal(processGroupMatches(0, 0), false);
});
