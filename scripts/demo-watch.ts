function credentials(): Array<{ token?: string; roles?: string[] }> {
  try { return JSON.parse(process.env.ASGUARD_API_CREDENTIALS ?? '[]') as Array<{ token?: string; roles?: string[] }>; }
  catch { throw new Error('ASGUARD_API_CREDENTIALS must be valid JSON for demo:watch.'); }
}

const configuredCredentials = credentials();
const runtimeToken = process.env.ASGUARD_DEMO_TOKEN || configuredCredentials.find((item) => item.roles?.includes('runtime'))?.token;
const readToken = configuredCredentials.find((item) => ['admin', 'operator', 'auditor'].some((role) => item.roles?.includes(role)))?.token;
const accountId = process.env.ASGUARD_WATCH_DEMO_ACCOUNT;
const agentId = process.env.ASGUARD_DEMO_AGENT_ID || 'near-watch-demo';
const network = `near:${process.env.ASGUARD_NEAR_NETWORK || 'testnet'}`;
const baseUrl = (process.env.ASGUARD_API_URL || `http://localhost:${process.env.ASGUARD_PORT || '8080'}`).replace(/\/$/, '');
if (!runtimeToken || Buffer.byteLength(runtimeToken, 'utf8') < 32) throw new Error('Configure a runtime credential or ASGUARD_DEMO_TOKEN for demo:watch.');
if (!readToken || Buffer.byteLength(readToken, 'utf8') < 32) throw new Error('Configure an admin, operator, or auditor credential in ASGUARD_API_CREDENTIALS to read watch activity.');
if (!accountId) throw new Error('Set ASGUARD_WATCH_DEMO_ACCOUNT to the public NEAR account ID to watch.');

async function main(): Promise<void> {
  const registered = await fetch(`${baseUrl}/api/wallet-watch`, {
    method: 'POST', headers: { Authorization: `Bearer ${runtimeToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, account_id: accountId, network, label: 'Judge wallet watch' }),
  });
  const registeredBody = await registered.json() as { wallet?: { id: string; account_id: string; network: string }; error?: string };
  if (!registered.ok || !registeredBody.wallet) throw new Error(registeredBody.error || `Wallet registration failed with HTTP ${registered.status}.`);
  console.log('Registered public account watch:', JSON.stringify(registeredBody.wallet));

  const headers = { Authorization: `Bearer ${readToken}` };
  const walletList = await fetch(`${baseUrl}/api/wallet-watch?agent_id=${encodeURIComponent(agentId)}`, { headers });
  const listBody = await walletList.json() as { wallets?: unknown[]; status?: unknown; error?: string };
  if (!walletList.ok) throw new Error(listBody.error || `Wallet list failed with HTTP ${walletList.status}.`);
  console.log('Watcher status and registered accounts:', JSON.stringify({ status: listBody.status, wallets: listBody.wallets }, null, 2));

  console.log('Polling local activity history for up to 35 seconds...');
  const endAt = Date.now() + 35_000;
  let activity: unknown[] = [];
  while (Date.now() < endAt) {
    const response = await fetch(`${baseUrl}/api/wallet-watch/activity?watch_id=${encodeURIComponent(registeredBody.wallet.id)}`, { headers });
    const body = await response.json() as { activity?: unknown[]; error?: string };
    if (!response.ok) throw new Error(body.error || `Activity query failed with HTTP ${response.status}.`);
    activity = body.activity ?? [];
    if (activity.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  console.log(JSON.stringify({ observed_activity: activity }, null, 2));
  if (activity.length === 0) console.log('No matching activity has been observed in the scan window; the watcher remains registered and continues polling.');
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
