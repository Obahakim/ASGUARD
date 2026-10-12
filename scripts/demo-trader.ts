/**
 * A no-cost paper trader for exercising ASGUARD's MCP and dashboard approval flow.
 * It reports synthetic events only and never signs or submits a blockchain transaction.
 */
const baseUrl = (process.env.ASGUARD_MCP_URL || `http://localhost:${process.env.ASGUARD_PORT || '8080'}/mcp`).replace(/\/$/, '');
const runtimeToken = process.env.ASGUARD_DEMO_TOKEN || (() => {
  try {
    const credentials = JSON.parse(process.env.ASGUARD_API_CREDENTIALS || '[]') as Array<{ token?: string; roles?: string[] }>;
    return credentials.find((credential) => credential.roles?.includes('runtime'))?.token;
  } catch {
    return undefined;
  }
})();

if (!runtimeToken || Buffer.byteLength(runtimeToken, 'utf8') < 32) {
  throw new Error('Set ASGUARD_DEMO_TOKEN or configure a runtime credential in ASGUARD_API_CREDENTIALS (minimum 32 bytes).');
}

let requestId = 0;
async function rpc(method: string, params?: Record<string, unknown>, notification = false) {
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${runtimeToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: ++requestId }), method, ...(params ? { params } : {}) }),
  });
  if (notification && response.status === 202) return undefined;
  const body = await response.json() as { error?: { message?: string }; result?: unknown };
  if (!response.ok || body.error) throw new Error(body.error?.message || `ASGUARD MCP returned HTTP ${response.status}.`);
  return body.result;
}

async function callTool(name: string, args: Record<string, unknown>) {
  const result = await rpc('tools/call', { name, arguments: args }) as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  const text = result.content?.find((part) => part.type === 'text')?.text || JSON.stringify(result);
  if (result.isError) throw new Error(text);
  return text;
}

async function main() {
  const initialized = await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'asguard-demo-trader', version: '1.0.0' },
  });
  await rpc('notifications/initialized', undefined, true);
  console.log('Connected to ASGUARD MCP at', baseUrl);
  console.log('Runtime status:', await callTool('asguard_get_status', {}));

  const agentId = process.env.ASGUARD_DEMO_AGENT_ID || 'demo-paper-trader';
  console.log('Reporting synthetic market observation…');
  console.log(await callTool('asguard_report_activity', {
    agent_id: agentId,
    agent_name: 'ASGUARD Paper Trader',
    action: 'Observe devnet market quote',
    risk_level: 'low',
    details: { simulated: true, pair: 'SOL/USDC', price_source: 'demo-only', action_taken: false },
  }));

  if (process.argv.includes('--activity-only')) return;
  console.log('Submitting a synthetic compromise alert. No transaction or wallet is involved.');
  console.log('Open the ASGUARD dashboard and respond to its pending approval request.');
  console.log(await callTool('asguard_report_security_violation', {
    agent_id: agentId,
    violation_type: 'demo_compromise_alert',
    severity: 'high',
    context: { simulated: true, reason: 'Paper-trader test of human intervention flow', stops_agent_process: false },
  }));
  console.log('Human-intervention flow returned. This demo reports the decision; it does not control a real agent process.');
  void initialized;
}

main().catch((error) => {
  console.error('Demo trader failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
