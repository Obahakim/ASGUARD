'use client';

import { useCallback, useEffect, useState } from 'react';
import { useBridgeConnection } from '../hooks/useBridgeConnection';
import type { HITLRequestEvent, TransactionIntent } from '../server/types';
import Navbar from './components/Navbar';
import Tabs from './components/Tabs';
import ActivityFeed from './components/ActivityFeed';
import SecurityRules from './components/SecurityRules';
import AnomalyDetection from './components/AnomalyDetection';
import ApprovalModal from './components/ApprovalModal';

export default function Home() {
  const [activeTab, setActiveTab] = useState('overview');
  const [apiToken, setApiToken] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [pendingApprovals, setPendingApprovals] = useState<HITLRequestEvent[]>([]);
  const pendingApproval = pendingApprovals[0] ?? null;
  const [chainStatus, setChainStatus] = useState('Chain status unavailable');
  const [transactions, setTransactions] = useState<TransactionIntent[]>([]);
  useEffect(() => {
    const savedToken = window.sessionStorage.getItem('asguard_api_token') || '';
    setApiToken(savedToken);
    setTokenInput(savedToken);
  }, []);
  const getWebSocketTicket = useCallback(async () => {
    if (!apiToken) throw new Error('Enter an ASGUARD API credential to connect.');
    const base = process.env.NEXT_PUBLIC_ASGUARD_API_URL || `${window.location.protocol}//${window.location.hostname}:8080`;
    const response = await fetch(`${base}/api/auth/ws-ticket`, {
      method: 'POST', headers: { Authorization: `Bearer ${apiToken}` },
    });
    const body = await response.json();
    if (!response.ok || !body.ticket) throw new Error(body.error || 'Could not authenticate dashboard connection.');
    return body.ticket as string;
  }, [apiToken]);
  const onEvent = useCallback((event: import('../server/types').Event) => {
    if (event.type === 'hitl_request') setPendingApprovals((items) => items.some((item) => item.request_id === event.request_id) ? items : [...items, event]);
  }, []);
  const { events, isConnected } = useBridgeConnection(onEvent, { getWebSocketTicket });
  useEffect(() => {
    if (!apiToken) { setChainStatus('Connect to load network status'); return; }
    let cancelled = false;
    const base = process.env.NEXT_PUBLIC_ASGUARD_API_URL || `${window.location.protocol}//${window.location.hostname}:8080`;
    Promise.all([
      fetch(`${base}/api/health`, { headers: { Authorization: `Bearer ${apiToken}` } }).then((res) => res.json()),
      fetch(`${base}/api/hitl/pending`, { headers: { Authorization: `Bearer ${apiToken}` } }).then((res) => res.json()),
      fetch(`${base}/api/transactions`, { headers: { Authorization: `Bearer ${apiToken}` } }).then((res) => res.json()),
    ]).then(([health, pending, txs]) => {
      if (cancelled) return;
      const chainName = typeof health.chain?.chain === 'string' ? health.chain.chain : 'NEAR';
      setChainStatus(health.chain?.healthy ? `${chainName} ${health.chain.network} connected` : `${chainName} ${health.chain?.network || 'unavailable'}`);
      if (Array.isArray(pending.requests)) setPendingApprovals(pending.requests);
      if (Array.isArray(txs.intents)) setTransactions(txs.intents);
    }).catch(() => { if (!cancelled) setChainStatus('Could not load network status'); });
    return () => { cancelled = true; };
  }, [apiToken, events.length]);
  const auditEvents = events.filter((event) => event.type === 'audit_log');

  const saveToken = () => {
    const nextToken = tokenInput.trim();
    if (nextToken) window.sessionStorage.setItem('asguard_api_token', nextToken);
    else window.sessionStorage.removeItem('asguard_api_token');
    setApiToken(nextToken);
  };

  const decideApproval = async (action: 'allow_once' | 'allow_session' | 'deny_terminate') => {
    if (!pendingApproval) return;
    const base = process.env.NEXT_PUBLIC_ASGUARD_API_URL || `${window.location.protocol}//${window.location.hostname}:8080`;
    const response = await fetch(`${base}/api/hitl/${encodeURIComponent(pendingApproval.request_id)}/respond`, {
      method: 'POST', headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, reason: 'Dashboard operator decision' }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Could not submit the approval decision.');
    setPendingApprovals((items) => items.filter((item) => item.request_id !== pendingApproval.request_id));
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <Navbar />

      <div className="max-w-7xl mx-auto px-6 py-8">
        <section className="mb-6 flex flex-col gap-3 rounded-lg border asguard-border bg-slate-900/60 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-slate-100">ASGUARD control connection</p>
            <p className="text-xs text-slate-400">{isConnected ? 'Authenticated live event stream' : 'Disconnected — use an API credential with operator or admin access'} · {chainStatus}</p>
          </div>
          <form className="flex w-full gap-2 sm:max-w-xl" onSubmit={(event) => { event.preventDefault(); saveToken(); }}>
            <input aria-label="ASGUARD API credential" type="password" autoComplete="off" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} placeholder="ASGUARD API credential" className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100" />
            <button type="submit" className="rounded bg-cyan-700 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-600">Connect</button>
            {apiToken && <button type="button" onClick={() => { setTokenInput(''); window.sessionStorage.removeItem('asguard_api_token'); setApiToken(''); }} className="rounded border border-slate-700 px-3 py-2 text-sm text-slate-300">Clear</button>}
          </form>
        </section>
        <Tabs activeTab={activeTab} onTabChange={setActiveTab} />

        {/* Overview Tab */}
        {activeTab === 'overview' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Column 1: Activity Feed */}
            <div className="bg-slate-900/50 rounded-lg border asguard-border p-6 backdrop-blur">
              <ActivityFeed events={events} />
            </div>

            {/* Column 2: Security Rules */}
            <div className="bg-slate-900/50 rounded-lg border asguard-border p-6 backdrop-blur">
              <SecurityRules apiToken={apiToken} />
            </div>

            {/* Column 3: Anomaly Detection */}
            <div className="bg-slate-900/50 rounded-lg border asguard-border p-6 backdrop-blur">
              <AnomalyDetection events={events} />
            </div>
          </div>
        )}

        {/* Rule Settings Tab */}
        {activeTab === 'rules' && (
          <div className="bg-slate-900/50 rounded-lg border asguard-border p-8 backdrop-blur">
            <div className="max-w-2xl">
              <h3 className="text-2xl font-bold text-slate-100 mb-6">Advanced Rule Configuration</h3>
              <div className="space-y-6">
                <div className="p-4 bg-slate-800/50 rounded-lg border asguard-border">
                  <p className="text-slate-300">
                    Configure global security policies, agent whitelisting, and custom threat detection rules.
                  </p>
                </div>
                <p className="text-sm text-slate-400">Pending agent approvals appear here as they arrive on the authenticated live bridge.</p>
              </div>
            </div>
          </div>
        )}

        {/* Audit Logs Tab */}
        {activeTab === 'logs' && (
          <div className="bg-slate-900/50 rounded-lg border asguard-border p-8 backdrop-blur">
            <h3 className="text-2xl font-bold text-slate-100 mb-6">Audit Logs</h3>
            <div className="mb-4 text-sm text-slate-400">
              Live bridge: <span className={isConnected ? 'text-emerald-400' : 'text-amber-400'}>{isConnected ? 'connected' : 'disconnected'}</span>
            </div>
            <div className="flex flex-col gap-2">
              {auditEvents.length === 0 ? (
                <div className="rounded-lg border asguard-border bg-slate-800/50 p-4 text-sm text-slate-400">
                  No audit events received yet. The dashboard is no longer showing fabricated log entries.
                </div>
              ) : auditEvents.slice(-25).reverse().map((event) => (
                <div key={event.id} className="rounded-lg border asguard-border bg-slate-800/50 p-3 text-sm text-slate-300 font-mono">
                  [{new Date(event.timestamp).toLocaleTimeString()}] {event.agent_id ?? 'system'} | {event.action} | {event.status}
                </div>
              ))}
            </div>
            <h4 className="mt-8 mb-3 text-lg font-semibold text-slate-100">Guarded transactions</h4>
            <div className="flex flex-col gap-2">
              {transactions.length === 0 ? <div className="rounded-lg border asguard-border bg-slate-800/50 p-4 text-sm text-slate-400">No transaction intents have been reported.</div> : transactions.slice(0, 30).map((intent) => (
                <div key={intent.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border asguard-border bg-slate-800/50 p-3 text-sm">
                  <div><p className="font-mono text-slate-200">{intent.agent_id} · {intent.action}</p><p className="mt-1 text-xs text-slate-400">{intent.network} · {intent.id}</p>{intent.preflight && <p className={`mt-1 text-xs ${intent.preflight.status === 'passed' ? 'text-emerald-300' : intent.preflight.status === 'blocked' ? 'text-red-300' : 'text-amber-300'}`}>Preflight {intent.preflight.status.replaceAll('_', ' ')} · {intent.preflight.kind.replaceAll('_', ' ')}{intent.preflight.reasons.length ? ` · ${intent.preflight.reasons.join(', ')}` : ''}</p>}</div>
                  <span className={intent.status === 'submitted' || intent.status === 'confirmed' ? 'text-emerald-400' : intent.status === 'blocked' || intent.status === 'rejected' || intent.status === 'failed' ? 'text-red-400' : 'text-amber-300'}>{intent.status.replaceAll('_', ' ')}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Approval Modal */}
      <ApprovalModal request={pendingApproval} onDecide={decideApproval} />
    </main>
  );
}
