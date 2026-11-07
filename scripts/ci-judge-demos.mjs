import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.resolve(process.env.ASGUARD_CI_ENV_PATH || path.join(root, '.env.ci'));
const keyDirectory = path.resolve(process.env.ASGUARD_CI_KEY_DIR || path.join(root, '.asguard-ci'));
const logDirectory = path.resolve(process.env.ASGUARD_CI_LOG_DIR || path.join(root, 'asguard-ci-logs'));
const requestedOnchain = process.env.ASGUARD_JUDGE_ONCHAIN === 'true';
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const results = [];

function readEnvFile(filePath) {
  const env = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1].startsWith('#')) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
      if (match[2].startsWith('"')) value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    env[match[1]] = value;
  }
  return env;
}

function tokensFrom(env) {
  let credentials;
  try { credentials = JSON.parse(env.ASGUARD_API_CREDENTIALS || ''); } catch { return []; }
  return Array.isArray(credentials)
    ? credentials.filter((item) => item && typeof item.token === 'string').map((item) => item.token)
    : [];
}

function redact(value, secrets) {
  let output = value;
  for (const secret of secrets.filter((item) => typeof item === 'string' && item.length >= 8).sort((a, b) => b.length - a.length)) {
    output = output.split(secret).join('[REDACTED]');
  }
  return output;
}

function writeLog(name, line) {
  fs.appendFileSync(path.join(logDirectory, name), `${line}\n`);
}

function decodeBase58(value) {
  let number = 0n;
  for (const character of value) {
    const digit = ALPHABET.indexOf(character);
    if (digit < 0) throw new Error('Tidepool demo private key is not valid base58.');
    number = number * 58n + BigInt(digit);
  }
  const bytes = [];
  while (number > 0n) {
    bytes.unshift(Number(number & 0xffn));
    number >>= 8n;
  }
  for (const character of value) {
    if (character !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

function tidepoolKeyMatches(privateKey, accountId) {
  try {
    const [curve, encoded, ...extra] = privateKey.trim().split(':');
    if (curve !== 'ed25519' || !encoded || extra.length || !/^[a-f0-9]{64}$/.test(accountId)) return false;
    const secret = decodeBase58(encoded);
    if (secret.length !== 64) return false;
    const key = crypto.createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, secret.subarray(0, 32)]),
      format: 'der',
      type: 'pkcs8',
    });
    const publicBytes = Buffer.from(crypto.createPublicKey(key).export({ format: 'der', type: 'spki' })).subarray(-32);
    return crypto.timingSafeEqual(publicBytes, secret.subarray(32)) && publicBytes.toString('hex') === accountId;
  } catch {
    return false;
  }
}

function report(name, status, reason = '') {
  const result = { name, status, ...(reason ? { reason } : {}) };
  results.push(result);
  console.log(JSON.stringify({ scenario: name, result: status, ...(reason ? { reason } : {}) }));
}

function finishSummary() {
  const passCount = results.filter((item) => item.status === 'PASS').length;
  const failCount = results.filter((item) => item.status === 'FAIL').length;
  const skipCount = results.filter((item) => item.status === 'SKIP').length;
  const summary = [
    '===== ASGUARD JUDGE SUMMARY =====',
    ...results.map((item) => `${item.status.padEnd(4)} ${item.name.replace(/^\d+-/, '')}${item.reason ? ` (${item.reason})` : ''}`),
    `===== DONE: ${passCount} passed, ${failCount} failed, ${skipCount} skipped =====`,
  ].join('\n');
  console.log(summary);
  fs.mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(logDirectory, 'summary.log'), `${summary}\n`);
  if (failCount > 0) process.exitCode = 1;
}

function startProcess(args, name, env, secrets, timeoutMs) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let settled = false;
  let timedOut = false;
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const result = new Promise((resolve, reject) => {
    child.once('error', (error) => {
      if (!settled) { settled = true; reject(error); }
    });
    child.once('close', (code, signal) => {
      if (!settled) {
        settled = true;
        const safeOutput = redact(output, secrets);
        writeLog(name, safeOutput.replace(/\r?\n$/, ''));
        resolve({ code: code ?? 1, signal, timedOut, output: safeOutput });
      }
    });
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  return {
    child,
    result: result.finally(() => clearTimeout(timer)),
    stop: () => { if (!child.killed) child.kill(); },
  };
}

async function runDemoScenario({ name, entry, args = [], expect, env = {}, hitl }) {
  const logName = `${name}.log`;
  fs.writeFileSync(path.join(logDirectory, logName), `${JSON.stringify({ scenario: name, event: 'started', at: new Date().toISOString() })}\n`);
  const childEnv = { ...process.env, ...demoEnv, ...env };
  let responder;
  if (hitl) {
    responder = startProcess(
      [path.join(root, 'scripts', 'ci-hitl-responder.mjs')],
      logName,
      {
        ...childEnv,
        ASGUARD_API_URL: demoEnv.ASGUARD_API_URL || `http://127.0.0.1:${demoEnv.ASGUARD_PORT || '8080'}`,
        ASGUARD_OPERATOR_TOKEN: operatorToken,
        HITL_ACTION: hitl.action,
        HITL_AGENT_ID: hitl.agentId,
        HITL_RESPONDER_TIMEOUT_MS: String(Math.max(180_000, hitl.timeoutMs || 0)),
      },
      secrets,
      Math.max(190_000, (hitl.timeoutMs || 0) + 10_000),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const demo = startProcess(
    [`--env-file=${envPath}`, '--import', 'tsx', path.join(root, entry), ...args],
    logName,
    childEnv,
    secrets,
    hitl?.timeoutMs || 220_000,
  );
  let demoResult;
  try {
    demoResult = await demo.result;
  } finally {
    responder?.stop();
  }
  const responderResult = responder
    ? await responder.result.catch((error) => ({ code: 1, output: String(error) }))
    : undefined;
  const passed = (!responder || responderResult.code === 0)
    && expect(demoResult, fs.readFileSync(path.join(logDirectory, logName), 'utf8'));
  writeLog(logName, JSON.stringify({ scenario: name, event: 'finished', result: passed ? 'PASS' : 'FAIL', exit_code: demoResult.code }));
  if (passed) report(name, 'PASS');
  else {
    const logText = fs.readFileSync(path.join(logDirectory, logName), 'utf8');
    const detail = demoResult.timedOut
      ? 'scenario timed out'
      : (logText.match(/(?:Tidepool[^\r\n]*|faucet[^\r\n]*|Error:[^\r\n]*|[A-Z_]+_mismatch[^\r\n]*)/i)?.[0] || `unexpected exit status ${demoResult.code}`);
    report(name, 'FAIL', detail.slice(0, 300));
  }
}

let demoEnv = {};
let operatorToken = '';
let secrets = [];

async function main() {
  fs.mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(logDirectory, 'summary.log'), '');
  if (!fs.existsSync(envPath)) {
    report('judge_preflight', 'FAIL', `env file not found: ${envPath}`);
    finishSummary();
    return;
  }
  demoEnv = readEnvFile(envPath);
  let credentials;
  try { credentials = JSON.parse(demoEnv.ASGUARD_API_CREDENTIALS || ''); } catch { credentials = []; }
  const operatorCredential = credentials.find((item) =>
    item && typeof item.token === 'string' && Array.isArray(item.roles)
      && item.roles.some((role) => role === 'admin' || role === 'operator'));
  operatorToken = process.env.ASGUARD_OPERATOR_TOKEN
    || (fs.existsSync(path.join(keyDirectory, 'ci-operator-token.txt'))
      ? fs.readFileSync(path.join(keyDirectory, 'ci-operator-token.txt'), 'utf8').trim()
      : operatorCredential?.token || '');
  secrets = [
    ...tokensFrom(demoEnv),
    demoEnv.ASGUARD_AUDIT_KEY,
    demoEnv.ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY,
    demoEnv.ASGUARD_DEMO_NEAR_PRIVATE_KEY,
    operatorToken,
  ].filter(Boolean);
  if (!operatorToken || !demoEnv.ASGUARD_API_CREDENTIALS) {
    report('judge_preflight', 'FAIL', 'operator credentials are missing from the configured env.');
    finishSummary();
    return;
  }
  const apiUrl = demoEnv.ASGUARD_API_URL || `http://127.0.0.1:${demoEnv.ASGUARD_PORT || '8080'}`;
  let response;
  try {
    response = await fetch(`${apiUrl.replace(/\/$/, '')}/api/policy`, {
      headers: { authorization: ['Bearer', operatorToken].join(' ') },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    report('judge_preflight', 'FAIL', `backend is not reachable at ${apiUrl}; start it with node --env-file=.env.ci --import tsx scripts/start-backend.ts.`);
    finishSummary();
    return;
  }
  if (!response.ok) {
    report('judge_preflight', 'FAIL', `backend preflight returned HTTP ${response.status}; confirm it uses the same .env.`);
    finishSummary();
    return;
  }

  await runDemoScenario({
    name: '01-block',
    entry: 'scripts/demo-near.ts',
    args: ['block'],
    expect: (result, log) => result.code === 0 && /expired intent rejected; no callback, signing, or submission/i.test(log),
  });
  await runDemoScenario({
    name: '02-hitl-deny',
    entry: 'scripts/demo-near.ts',
    args: ['hitl'],
    hitl: { action: 'deny_terminate', agentId: 'near-demo-hitl' },
    expect: (result, log) => result.code !== 0
      && /"callback":\s*"not_called"/.test(log)
      && /"action":"deny_terminate"/.test(log),
  });
  await runDemoScenario({
    name: '03-hitl-allow',
    entry: 'scripts/demo-near.ts',
    args: ['hitl'],
    hitl: { action: 'allow_once', agentId: 'near-demo-hitl' },
    expect: (result, log) => result.code === 0
      && /"status":\s*"approved"/.test(log)
      && /Verified host callback reached/.test(log)
      && /"action":"allow_once"/.test(log),
  });
  await runDemoScenario({
    name: '04-tidepool-tamper',
    entry: 'scripts/demo-near-tidepool.ts',
    args: ['tamper'],
    hitl: { action: 'allow_once', agentId: 'asguard-tidepool-testnet-demo' },
    expect: (result, log) => result.code === 0
      && /payload binding rejected change after approval/.test(log)
      && /"status":\s*"tamper_rejected"/.test(log)
      && /"submission_attempted":\s*false/.test(log),
  });
  await runDemoScenario({
    name: '05-tidepool-approve',
    entry: 'scripts/demo-near-tidepool.ts',
    args: ['approve'],
    env: { ASGUARD_DEMO_TIDEPOOL_SETTLE: 'false', ASGUARD_DEMO_TIDEPOOL_FAUCET: 'false' },
    hitl: { action: 'allow_once', agentId: 'asguard-tidepool-testnet-demo' },
    expect: (result, log) => result.code === 0
      && /"status":\s*"approved"/.test(log)
      && /Approval-only run complete\. No signing, submission, or value movement occurred/.test(log)
      && /"action":"allow_once"/.test(log),
  });

  if (!requestedOnchain) {
    report('tidepool_onchain', 'SKIP', 'on-chain settlement was not requested.');
  } else if (demoEnv.ASGUARD_DEMO_TIDEPOOL_SETTLE !== 'true'
    || demoEnv.ASGUARD_DEMO_TIDEPOOL_FAUCET !== 'true'
    || !demoEnv.ASGUARD_DEMO_TIDEPOOL_ACCOUNT_ID
    || !demoEnv.ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY
    || !tidepoolKeyMatches(demoEnv.ASGUARD_DEMO_TIDEPOOL_PRIVATE_KEY, demoEnv.ASGUARD_DEMO_TIDEPOOL_ACCOUNT_ID)) {
    report('tidepool_onchain', 'FAIL', 'on-chain was requested but Tidepool testnet wallet, faucet, settlement, or key match is not configured.');
  } else {
    await runDemoScenario({
      name: '06-tidepool-onchain',
      entry: 'scripts/demo-near-tidepool.ts',
      args: ['onchain'],
      hitl: { action: 'allow_once', agentId: 'asguard-tidepool-testnet-demo', timeoutMs: 300_000 },
      expect: (result, log) => result.code === 0
        && /"status":\s*"SUCCESS"/.test(log)
        && /On-chain Tidepool testnet demo completed successfully/.test(log)
        && /(?:tx_hash|explorer_url)/.test(log),
    });
  }

  finishSummary();
}

void main().catch((error) => {
  const message = redact(error instanceof Error ? error.message : String(error), secrets);
  report('judge_runner', 'FAIL', message);
  finishSummary();
});
