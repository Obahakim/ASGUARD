const apiUrl = (process.env.ASGUARD_API_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const token = process.env.ASGUARD_OPERATOR_TOKEN;
const action = process.env.HITL_ACTION || 'allow_once';
const agentFilter = process.env.HITL_AGENT_ID;
const timeoutMs = Number(process.env.HITL_RESPONDER_TIMEOUT_MS || 180_000);
const intervalMs = Number(process.env.HITL_RESPONDER_INTERVAL_MS || 500);

function fail(message) {
  process.stderr.write(`[ASGUARD HITL responder] ${message}\n`);
  process.exitCode = 1;
}

async function main() {
  if (!token || Buffer.byteLength(token, 'utf8') < 32) throw new Error('ASGUARD_OPERATOR_TOKEN must contain an operator/admin token of at least 32 bytes.');
  if (!['allow_once', 'allow_session', 'deny_terminate'].includes(action)) throw new Error('HITL_ACTION must be allow_once, allow_session, or deny_terminate.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) throw new Error('HITL_RESPONDER_TIMEOUT_MS must be from 1000 to 600000.');
  if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 10_000) throw new Error('HITL_RESPONDER_INTERVAL_MS must be from 100 to 10000.');
  const endpoint = new URL(apiUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('ASGUARD_API_URL must be an HTTP(S) URL without credentials.');

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let response;
    try {
      response = await fetch(`${apiUrl}/api/hitl/pending`, {
        headers: { authorization: ['Bearer', token].join(' ') },
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      if (Date.now() + intervalMs >= deadline) throw new Error(`Could not poll pending HITL requests: ${error instanceof Error ? error.message : String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      continue;
    }
    if (!response.ok) throw new Error(`GET /api/hitl/pending failed with HTTP ${response.status}.`);
    const body = await response.json();
    if (!body || !Array.isArray(body.requests)) throw new Error('GET /api/hitl/pending returned an invalid response.');
    const pending = body.requests.find((item) => item && typeof item.request_id === 'string'
      && (!agentFilter || item.agent_id === agentFilter));
    if (pending) {
      const decision = await fetch(`${apiUrl}/api/hitl/${encodeURIComponent(pending.request_id)}/respond`, {
        method: 'POST',
        headers: { authorization: ['Bearer', token].join(' '), 'content-type': 'application/json' },
        body: JSON.stringify({ action, reason: `CI auto ${action}` }),
        signal: AbortSignal.timeout(5_000),
      });
      if (decision.status === 404) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }
      if (!decision.ok) throw new Error(`POST /api/hitl/:request_id/respond failed with HTTP ${decision.status}.`);
      process.stdout.write(`${JSON.stringify({ hitl_auto: true, request_id: pending.request_id, action })}\n`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for a matching HITL request${agentFilter ? ` for ${agentFilter}` : ''}.`);
}

void main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
