import { runDemo } from './demo-common';

void runDemo('demo:watch', async (config) => {
  const accountId = process.env.ASGUARD_WATCH_DEMO_ACCOUNT?.trim();
  if (!accountId) {
    throw new Error('Set ASGUARD_WATCH_DEMO_ACCOUNT in .env to a public NEAR testnet account ID, then retry. Do not provide a private key or seed phrase.');
  }
  const agentId = process.env.ASGUARD_DEMO_AGENT_ID || 'near-watch-demo';
  const registerHeaders = {
    Authorization: `Bearer ${config.runtimeToken}`,
    'Content-Type': 'application/json',
  };

  let registered: Response;
  try {
    registered = await fetch(`${config.apiUrl}/api/wallet-watch`, {
      method: 'POST',
      headers: registerHeaders,
      body: JSON.stringify({
        agent_id: agentId,
        account_id: accountId,
        network: config.network,
        label: 'Judge wallet watch',
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error(`Backend request failed during wallet-watch registration. Confirm that "npm run dev:backend" is still running at ${config.apiUrl}.`);
  }
  const registeredBody = await registered.json().catch(() => ({})) as {
    wallet?: { id: string; account_id: string; network: string };
    error?: string;
  };
  if (!registered.ok || !registeredBody.wallet) {
    throw new Error(registeredBody.error || `Wallet registration failed with HTTP ${registered.status}.`);
  }
  console.log('Registered public testnet account watch:', JSON.stringify(registeredBody.wallet));

  let walletResponse: Response;
  let activityResponse: Response;
  try {
    [walletResponse, activityResponse] = await Promise.all([
      fetch(`${config.apiUrl}/api/wallet-watch?agent_id=${encodeURIComponent(agentId)}`, {
        headers: { Authorization: `Bearer ${config.readToken}` },
        signal: AbortSignal.timeout(10_000),
      }),
      fetch(`${config.apiUrl}/api/wallet-watch/activity?watch_id=${encodeURIComponent(registeredBody.wallet.id)}`, {
        headers: { Authorization: `Bearer ${config.readToken}` },
        signal: AbortSignal.timeout(10_000),
      }),
    ]);
  } catch {
    throw new Error(`Backend request failed while reading wallet-watch status. Confirm that "npm run dev:backend" is still running at ${config.apiUrl}.`);
  }
  const [walletBody, activityBody] = await Promise.all([
    walletResponse.json().catch(() => ({})) as Promise<{ wallets?: unknown[]; status?: unknown; error?: string }>,
    activityResponse.json().catch(() => ({})) as Promise<{ activity?: unknown[]; error?: string }>,
  ]);
  if (!walletResponse.ok) throw new Error(walletBody.error || `Wallet list failed with HTTP ${walletResponse.status}.`);
  if (!activityResponse.ok) throw new Error(activityBody.error || `Activity query failed with HTTP ${activityResponse.status}.`);

  const activity = activityBody.activity ?? [];
  console.log(JSON.stringify({
    watcher_status: walletBody.status,
    registered_wallets: walletBody.wallets ?? [],
    observed_activity: activity,
  }, null, 2));
  if (activity.length === 0) {
    console.log('No matching activity is recorded yet. Registration and local history queries succeeded; the read-only watcher continues in the backend.');
  } else {
    console.log('Existing observed activity is shown above. The watcher is read-only and submits no transactions.');
  }
});
