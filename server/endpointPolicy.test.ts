import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HTTP_LOOPBACK_HOSTNAMES, isAllowedApiEndpoint, isHttpLoopbackUrl } from './endpointPolicy';

test('endpoint policy accepts HTTPS and exact HTTP loopback hosts only', () => {
  for (const value of ['https://example.com', 'http://localhost:8080', 'http://127.0.0.1:8080', 'http://[::1]:8080']) {
    assert.equal(isAllowedApiEndpoint(new URL(value)), true, value);
  }
  for (const value of ['http://example.com', 'http://localhost.evil.com', 'http://127.0.0.2', 'http://[::2]:8080', 'ftp://localhost']) {
    const url = new URL(value);
    assert.equal(isAllowedApiEndpoint(url), false, value);
    assert.equal(isHttpLoopbackUrl(url), false, value);
  }
  assert.equal(new URL('http://[::1]:8080').hostname, '[::1]');
  assert.deepEqual(HTTP_LOOPBACK_HOSTNAMES, ['localhost', '127.0.0.1', '[::1]']);
});

test('no source file keeps an unbracketed IPv6 loopback allow-list entry', () => {
  const root = process.cwd();
  const forbidden = "'::" + "1'";
  const self = path.join(root, 'server', 'endpointPolicy.test.ts');
  const visit = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return visit(full);
    return entry.isFile() && entry.name.endsWith('.ts') && full !== self
      && fs.readFileSync(full, 'utf8').includes(forbidden) ? [path.relative(root, full)] : [];
  });
  for (const directory of ['server', 'agent-sdk', 'scripts', 'cli']) assert.deepEqual(visit(path.join(root, directory)), [], directory);
});
