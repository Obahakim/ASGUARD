'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { WatchedNearActivity, WatchedNearWallet, NearWalletWatchStatus } from '../../server/nearWalletWatch';

interface WatchResponse { success: boolean; wallets: WatchedNearWallet[]; status: NearWalletWatchStatus; error?: string }
interface ActivityResponse { success: boolean; activity: WatchedNearActivity[]; error?: string }

function apiBase(): string {
  return process.env.NEXT_PUBLIC_ASGUARD_API_URL || `${window.location.protocol}//${window.location.hostname}:8080`;
}

export default function WalletWatchPanel({ apiToken }: { apiToken: string }) {
  const [wallets, setWallets] = useState<WatchedNearWallet[]>([]);
  const [activity, setActivity] = useState<WatchedNearActivity[]>([]);
  const [watchStatus, setWatchStatus] = useState<NearWalletWatchStatus>();
  const [agentId, setAgentId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [network, setNetwork] = useState<'near:testnet' | 'near:mainnet'>('near:testnet');
  const [label, setLabel] = useState('');
  const [selectedWatch, setSelectedWatch] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (watchId?: string) => {
    if (!apiToken) return;
    const headers = { Authorization: `Bearer ${apiToken}` };
    const [watchResponse, activityResponse] = await Promise.all([
      fetch(`${apiBase()}/api/wallet-watch`, { headers }),
      fetch(`${apiBase()}/api/wallet-watch/activity${watchId ? `?watch_id=${encodeURIComponent(watchId)}` : ''}`, { headers }),
    ]);
    const watchBody = await watchResponse.json() as WatchResponse;
    const activityBody = await activityResponse.json() as ActivityResponse;
    if (!watchResponse.ok) throw new Error(watchBody.error || 'Could not load watched wallets.');
    if (!activityResponse.ok) throw new Error(activityBody.error || 'Could not load wallet activity.');
    setWallets(watchBody.wallets);
    setWatchStatus(watchBody.status);
    setActivity(activityBody.activity);
    if (watchId && !watchBody.wallets.some((wallet) => wallet.id === watchId)) setSelectedWatch('');
  }, [apiToken]);

  useEffect(() => {
    let cancelled = false;
    if (!apiToken) return;
    refresh(selectedWatch).catch((error) => { if (!cancelled) setMessage(error instanceof Error ? error.message : 'Could not load wallet watches.'); });
    const timer = window.setInterval(() => {
      refresh(selectedWatch).catch((error) => { if (!cancelled) setMessage(error instanceof Error ? error.message : 'Could not refresh wallet watches.'); });
    }, 15_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [apiToken, refresh, selectedWatch]);

  const register = async (event: FormEvent) => {
    event.preventDefault();
    if (!apiToken) { setMessage('Connect with a runtime or admin credential to register a watch.'); return; }
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`${apiBase()}/api/wallet-watch`, {
        method: 'POST', headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, account_id: accountId, network, label: label || undefined }),
      });
      const body = await response.json() as { success?: boolean; wallet?: WatchedNearWallet; error?: string };
      if (!response.ok || !body.wallet) throw new Error(body.error || 'Could not register wallet watch.');
      setMessage(`Watching ${body.wallet.account_id} on ${body.wallet.network}.`);
      setAccountId(''); setLabel('');
      await refresh(selectedWatch);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not register wallet watch.'); }
    finally { setBusy(false); }
  };

  const deactivate = async (watch: WatchedNearWallet) => {
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`${apiBase()}/api/wallet-watch/${encodeURIComponent(watch.id)}/deactivate`, { method: 'POST', headers: { Authorization: `Bearer ${apiToken}` } });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || 'Could not deactivate wallet watch.');
      setMessage(`Stopped watching ${watch.account_id}.`);
      await refresh(selectedWatch);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not deactivate wallet watch.'); }
    finally { setBusy(false); }
  };

  return <section className="space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-3 rounded-lg border asguard-border bg-slate-900/60 p-5">
      <div><h2 className="text-xl font-semibold text-slate-100">NEAR wallet watch</h2><p className="mt-1 text-sm text-slate-400">Read-only public transaction and receipt monitoring for registered bot accounts.</p></div>
      <div className={`rounded border px-3 py-2 text-sm ${watchStatus?.healthy ? 'border-emerald-400/30 text-emerald-300' : 'border-amber-400/30 text-amber-200'}`}>
        {watchStatus ? `${watchStatus.healthy ? 'Healthy' : 'Degraded'} · ${watchStatus.watched_wallets} active · ${watchStatus.interval_ms} ms` : 'Connect to load watcher status'}
      </div>
      {watchStatus?.last_error && <p className="w-full text-sm text-amber-200">Last watcher error: {watchStatus.last_error}</p>}
    </header>

    <div className="grid gap-6 lg:grid-cols-[minmax(18rem,1fr)_2fr]">
      <form onSubmit={register} className="space-y-3 rounded-lg border asguard-border bg-slate-900/50 p-5">
        <h3 className="font-semibold text-slate-100">Register account</h3>
        <label className="block text-xs text-slate-400">Agent ID<input required maxLength={128} value={agentId} onChange={(event) => setAgentId(event.target.value)} className="mt-1 w-full rounded border asguard-border bg-slate-950 px-3 py-2 text-sm text-slate-100" /></label>
        <label className="block text-xs text-slate-400">NEAR account ID<input required maxLength={64} value={accountId} onChange={(event) => setAccountId(event.target.value)} placeholder="bot.near" className="mt-1 w-full rounded border asguard-border bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100" /></label>
        <label className="block text-xs text-slate-400">Network<select value={network} onChange={(event) => setNetwork(event.target.value as typeof network)} className="mt-1 w-full rounded border asguard-border bg-slate-950 px-3 py-2 text-sm text-slate-100"><option value="near:testnet">NEAR testnet</option><option value="near:mainnet">NEAR mainnet</option></select></label>
        <label className="block text-xs text-slate-400">Label<input maxLength={128} value={label} onChange={(event) => setLabel(event.target.value)} className="mt-1 w-full rounded border asguard-border bg-slate-950 px-3 py-2 text-sm text-slate-100" /></label>
        <button disabled={busy || !apiToken} className="w-full rounded bg-cyan-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Working...' : 'Start watching'}</button>
        <p role="status" className="text-xs text-slate-400">{message || 'Watch registration uses a runtime or admin role. Managing existing watches requires an operator role.'}</p>
      </form>

      <div className="space-y-6">
        <div className="rounded-lg border asguard-border bg-slate-900/50 p-5">
          <h3 className="mb-3 font-semibold text-slate-100">Watched accounts</h3>
          {!apiToken ? <p className="text-sm text-slate-400">Connect with an authenticated operator or auditor credential to view watches.</p>
            : wallets.length === 0 ? <p className="text-sm text-slate-400">No wallet watches are registered.</p>
              : <div className="space-y-2">{wallets.map((watch) => <div key={watch.id} className="flex flex-wrap items-center justify-between gap-3 rounded border asguard-border bg-slate-950/60 p-3">
                <button type="button" onClick={() => setSelectedWatch(selectedWatch === watch.id ? '' : watch.id)} className="min-w-0 text-left"><span className="block truncate font-mono text-sm text-cyan-200">{watch.account_id} · {watch.network}</span><span className="text-xs text-slate-400">{watch.agent_id}{watch.label !== watch.account_id ? ` · ${watch.label}` : ''} · {watch.active ? 'active' : 'inactive'}{watch.last_tx_hint ? ` · last ${watch.last_tx_hint}` : ''}</span></button>
                {watch.active && <button type="button" disabled={busy} onClick={() => void deactivate(watch)} className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 disabled:opacity-50">Stop</button>}
              </div>)}</div>}
        </div>

        <div className="rounded-lg border asguard-border bg-slate-900/50 p-5">
          <h3 className="mb-3 font-semibold text-slate-100">Observed activity</h3>
          {activity.length === 0 ? <p className="text-sm text-slate-400">No observed activity for this selection yet. The watcher scans finalized NEAR blocks and stores matching public transactions and receipts.</p>
            : <div className="max-h-[28rem] space-y-2 overflow-y-auto">{activity.map((item) => <article key={item.id} className="rounded border asguard-border bg-slate-950/60 p-3 text-sm">
              <div className="flex flex-wrap justify-between gap-2"><span className="font-mono text-cyan-200">{item.account_id} · {item.direction}</span><span className="text-xs text-slate-400">{item.network} · block {item.block_height}</span></div>
              <p className="mt-1 break-all font-mono text-xs text-slate-300">{item.transaction_hash}</p>
              <p className="mt-1 text-xs text-slate-400">{item.signer_id ?? 'unknown signer'} → {item.receiver_id ?? 'unknown receiver'} · {item.action_kinds.join(', ') || 'unknown action'}</p>
            </article>)}</div>}
        </div>
      </div>
    </div>
  </section>;
}
