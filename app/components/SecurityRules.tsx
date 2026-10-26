'use client';

import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AsguardPolicy } from '../../server/types';

type ListField =
  | 'allowed_intent_types' | 'denied_intent_types'
  | 'allowed_assets' | 'denied_assets'
  | 'allowed_destinations' | 'denied_destinations'
  | 'allowed_intent_chains' | 'denied_intent_chains';

const listFields: Array<{ field: ListField; label: string }> = [
  { field: 'allowed_assets', label: 'Allowed assets' },
  { field: 'denied_assets', label: 'Denied assets' },
  { field: 'allowed_destinations', label: 'Allowed recipients' },
  { field: 'denied_destinations', label: 'Denied recipients' },
  { field: 'allowed_intent_types', label: 'Allowed intent types' },
  { field: 'denied_intent_types', label: 'Denied intent types' },
  { field: 'allowed_intent_chains', label: 'Allowed destination chains' },
  { field: 'denied_intent_chains', label: 'Denied destination chains' },
];

const defaults: AsguardPolicy = {
  max_auto_trade_usd: 10000,
  strict_anomaly_detection: true,
  device_ip_lock: true,
  remote_trigger_protection: true,
  active_llm_engine: 'ollama',
  allowed_intent_types: [],
  denied_intent_types: [],
  allowed_assets: [],
  denied_assets: [],
  allowed_destinations: [],
  denied_destinations: [],
  allowed_intent_chains: [],
  denied_intent_chains: [],
  max_slippage_bps: 1000,
  allowed_intent_hours_utc: [],
  intent_unknown_target_requires_hitl: true,
};

export default function SecurityRules({ apiToken }: { apiToken: string }) {
  const [policy, setPolicy] = useState<AsguardPolicy>(defaults);
  const [message, setMessage] = useState('Connect with an admin API credential to load policy.');
  const [busy, setBusy] = useState(false);
  const apiBase = process.env.NEXT_PUBLIC_ASGUARD_API_URL || (typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.hostname}:8080`
    : 'http://localhost:8080');
  const headers = { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' };

  useEffect(() => {
    if (!apiToken) return;
    let cancelled = false;
    fetch(`${apiBase}/api/policy`, { headers: { Authorization: `Bearer ${apiToken}` } })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Could not load policy.');
        return body.policy as AsguardPolicy;
      })
      .then(nextPolicy => {
        if (!cancelled) {
          setPolicy({ ...defaults, ...nextPolicy });
          setMessage('Policy loaded from ASGUARD.');
        }
      })
      .catch(error => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : 'Could not load policy.');
      });
    return () => { cancelled = true; };
  }, [apiToken, apiBase]);

  const save = async () => {
    if (!apiToken) { setMessage('Connect with an admin API credential to change policy.'); return; }
    setBusy(true);
    try {
      for (const [field, value] of Object.entries(policy)) {
        if (field === 'updated_at' || field === 'version') continue;
        const response = await fetch(`${apiBase}/api/policy`, {
          method: 'POST', headers,
          body: JSON.stringify({ field, value }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Policy update failed.');
      }
      setMessage('Policy saved to ASGUARD.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Policy update failed.');
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!apiToken) { setMessage('Connect with an admin API credential to reset policy.'); return; }
    setBusy(true);
    try {
      const response = await fetch(`${apiBase}/api/policy/reset`, { method: 'POST', headers });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Policy reset failed.');
      setPolicy({ ...defaults, ...body.policy });
      setMessage('Policy reset to ASGUARD defaults.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Policy reset failed.');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (field: 'strict_anomaly_detection' | 'device_ip_lock' | 'remote_trigger_protection' | 'intent_unknown_target_requires_hitl', label: string) => (
    <label key={field} className="flex items-center justify-between gap-4 border-b asguard-border py-3">
      <span className="text-sm text-slate-200">{label}</span>
      <input
        type="checkbox"
        checked={policy[field] ?? false}
        onChange={event => setPolicy({ ...policy, [field]: event.target.checked })}
        className="h-4 w-4 accent-emerald-400"
      />
    </label>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="mb-4 flex items-center gap-2">
        <SlidersHorizontal aria-hidden="true" className="h-5 w-5 text-emerald-300" />
        <h2 className="text-lg font-semibold text-slate-100">NEAR Intent Policy</h2>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto pr-1">
        <label className="block text-sm font-semibold text-slate-200">
          Maximum spend (USD)
          <input type="number" min="0" step="0.01" value={policy.max_auto_trade_usd}
            onChange={event => setPolicy({ ...policy, max_auto_trade_usd: Number(event.target.value) })}
            className="mt-2 w-full rounded border asguard-border bg-slate-800 px-3 py-2 font-mono text-emerald-200" />
        </label>
        <label className="block text-sm font-semibold text-slate-200">
          Maximum slippage (basis points)
          <input type="number" min="0" max="10000" step="1" value={policy.max_slippage_bps ?? 1000}
            onChange={event => setPolicy({ ...policy, max_slippage_bps: Number(event.target.value) })}
            className="mt-2 w-full rounded border asguard-border bg-slate-800 px-3 py-2 font-mono text-emerald-200" />
        </label>
        <label className="block text-sm font-semibold text-slate-200">
          Allowed UTC hours (empty means any hour; comma-separated)
          <input type="text" value={(policy.allowed_intent_hours_utc ?? []).join(', ')}
            onChange={event => setPolicy({ ...policy, allowed_intent_hours_utc: event.target.value.split(',').map(value => value.trim()).filter(Boolean).map(Number) })}
            className="mt-2 w-full rounded border asguard-border bg-slate-800 px-3 py-2 font-mono text-emerald-200" />
        </label>
        <div className="space-y-1">
          {toggle('strict_anomaly_detection', 'Strict anomaly detection')}
          {toggle('device_ip_lock', 'Enforce known device and IP')}
          {toggle('remote_trigger_protection', 'Protect remote triggers')}
          {toggle('intent_unknown_target_requires_hitl', 'Require HITL for incomplete targets')}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {listFields.map(({ field, label }) => (
            <label key={field} className="block text-xs font-semibold text-slate-300">
              {label} (one per line)
              <textarea rows={3} value={(policy[field] ?? []).join('\n')}
                onChange={event => setPolicy({ ...policy, [field]: event.target.value.split('\n').map(value => value.trim()).filter(Boolean) })}
                className="mt-1 w-full resize-y rounded border asguard-border bg-slate-800 px-2 py-1.5 font-mono text-xs text-slate-100" />
            </label>
          ))}
        </div>
      </div>
      <div className="mt-4 space-y-2 border-t asguard-border pt-4">
        <p role="status" className="text-xs text-slate-400">{message}</p>
        <button disabled={busy} onClick={save} className="w-full rounded bg-emerald-400 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300 disabled:opacity-50">
          {busy ? 'Saving...' : 'Save Policy'}
        </button>
        <button disabled={busy} onClick={reset} className="w-full rounded border asguard-border bg-slate-900 px-3 py-2 text-sm text-slate-100 transition hover:bg-slate-800 disabled:opacity-50">
          Reset to defaults
        </button>
      </div>
    </div>
  );
}