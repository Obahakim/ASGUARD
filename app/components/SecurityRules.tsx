'use client';

import { Sliders } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AsguardPolicy } from '../../server/types';

const defaults: AsguardPolicy = {
  max_auto_trade_usd: 10000,
  strict_anomaly_detection: true,
  device_ip_lock: true,
  remote_trigger_protection: true,
  active_llm_engine: 'ollama',
  high_risk_bins: [],
  blocked_instrument_fingerprints: [],
};

export default function SecurityRules({ apiToken }: { apiToken: string }) {
  const [policy, setPolicy] = useState<AsguardPolicy>(defaults);
  const [message, setMessage] = useState('Connect with an admin API credential to load policy.');
  const [busy, setBusy] = useState(false);
  const apiBase = process.env.NEXT_PUBLIC_ASGUARD_API_URL || (typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.hostname}:8080` : 'http://localhost:8080');
  const headers = { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' };

  useEffect(() => {
    if (!apiToken) return;
    let cancelled = false;
    fetch(`${apiBase}/api/policy`, { headers: { Authorization: `Bearer ${apiToken}` } })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Could not load policy.');
        return body.policy as AsguardPolicy;
      })
      .then((loaded) => { if (!cancelled) { setPolicy({ ...defaults, ...loaded }); setMessage('Policy loaded from Payguard.'); } })
      .catch((error) => { if (!cancelled) setMessage(error instanceof Error ? error.message : 'Could not load policy.'); });
    return () => { cancelled = true; };
  }, [apiBase, apiToken]);

  const save = async () => {
    if (!apiToken) { setMessage('Connect with an admin API credential to change policy.'); return; }
    setBusy(true);
    try {
      for (const [field, value] of Object.entries(policy)) {
        if (field === 'updated_at' || field === 'version') continue;
        const response = await fetch(`${apiBase}/api/policy`, { method: 'POST', headers, body: JSON.stringify({ field, value }) });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Policy update failed.');
      }
      setMessage('Policy saved to Payguard.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Policy update failed.'); }
    finally { setBusy(false); }
  };

  const reset = async () => {
    if (!apiToken) { setMessage('Connect with an admin API credential to reset policy.'); return; }
    setBusy(true);
    try {
      const response = await fetch(`${apiBase}/api/policy/reset`, { method: 'POST', headers });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Policy reset failed.');
      setPolicy({ ...defaults, ...body.policy });
      setMessage('Policy reset to Payguard defaults.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Policy reset failed.'); }
    finally { setBusy(false); }
  };

  const toggle = (field: 'strict_anomaly_detection' | 'device_ip_lock' | 'remote_trigger_protection', label: string, description: string) => (
    <div className="flex items-center justify-between rounded-lg border asguard-border bg-slate-900/50 p-3">
      <div><p className="text-sm font-semibold text-slate-100">{label}</p><p className="mt-1 text-xs text-slate-400">{description}</p></div>
      <button type="button" aria-label={label} aria-pressed={policy[field]} onClick={() => setPolicy({ ...policy, [field]: !policy[field] })} className={`relative h-7 w-12 rounded-full transition ${policy[field] ? 'bg-green-500' : 'bg-slate-700'}`}>
        <span className={`absolute top-1 h-5 w-5 rounded-full bg-white transition ${policy[field] ? 'translate-x-6' : 'translate-x-1'}`} />
      </button>
    </div>
  );

  const listField = (field: 'high_risk_bins' | 'blocked_instrument_fingerprints', label: string, description: string) => (
    <label className="block text-sm font-semibold text-slate-200">{label}
      <textarea rows={3} value={(policy[field] ?? []).join('\n')} onChange={(event) => setPolicy({ ...policy, [field]: event.target.value.split(/[\n,]/).map((value) => value.trim()).filter(Boolean) })} className="mt-2 w-full rounded border asguard-border bg-slate-800 px-3 py-2 font-mono text-xs text-cyan-300" />
      <span className="mt-1 block text-xs font-normal text-slate-400">{description}</span>
    </label>
  );

  return <div className="flex h-full flex-col">
    <div className="mb-4 flex items-center gap-2"><div className="rounded-lg bg-purple-500/10 p-2"><Sliders className="h-5 w-5 text-purple-400" /></div><h2 className="text-lg font-semibold text-slate-100">Payment Security Policy</h2></div>
    <div className="flex-1 space-y-5">
      <label className="block text-sm font-semibold text-slate-200">Maximum Automatic Consumer Payment (USD)
        <input type="number" min="0" step="0.01" value={policy.max_auto_trade_usd} onChange={(event) => setPolicy({ ...policy, max_auto_trade_usd: Number(event.target.value) })} className="mt-2 w-full rounded border asguard-border bg-slate-800 px-3 py-2 font-mono text-cyan-300" />
      </label>
      {listField('high_risk_bins', 'High-risk card BINs', 'One 6–8 digit BIN per line. Do not enter card numbers.')}
      {listField('blocked_instrument_fingerprints', 'Blocked instrument fingerprints', 'Enter PayPal or processor tokenized fingerprints only; never enter PANs or CVVs.')}
      {toggle('strict_anomaly_detection', 'Behavioral Detection', 'Score unusual account and payment activity')}
      {toggle('device_ip_lock', 'Known Device & Network', 'Flag personal account activity from unrecognized devices or IPs')}
      {toggle('remote_trigger_protection', 'Remote Action Protection', 'Require review for sensitive account actions')}
    </div>
    <div className="mt-4 space-y-2 border-t asguard-border pt-4">
      <p role="status" className="text-xs text-slate-400">{message}</p>
      <button disabled={busy} onClick={save} className="w-full rounded bg-cyan-500 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-600 disabled:opacity-50">{busy ? 'Saving…' : 'Save Policy'}</button>
      <button disabled={busy} onClick={reset} className="w-full rounded border asguard-border bg-slate-900 px-3 py-2 text-sm text-slate-100 transition hover:bg-slate-800 disabled:opacity-50">Reset to Default</button>
    </div>
  </div>;
}
