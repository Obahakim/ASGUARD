'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { AgentVerificationRecord, AgentVerificationStatus } from '../../server/agentVerification';
import type { WatchedNearActivity, WatchedNearWallet } from '../../server/nearWalletWatch';

type Request = (path: string, init?: RequestInit) => Promise<Record<string, unknown>>;
type AgentSummary = { agent_id: string; agent_name?: string };

function AgentRow({
  agent,
  request,
  verification,
  verificationLoaded,
  busy,
  onVerificationChange,
}: {
  agent: AgentSummary;
  request: Request;
  verification?: AgentVerificationRecord;
  verificationLoaded: boolean;
  busy: boolean;
  onVerificationChange: (agentId: string, status: AgentVerificationStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [wallets, setWallets] = useState<WatchedNearWallet[]>([]);
  const [activity, setActivity] = useState<WatchedNearActivity[]>([]);
  const status = verification?.status ?? (verificationLoaded ? 'unverified' : 'loading');

  const toggle = async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (loaded || loading) return;
    setLoading(true);
    setError('');
    try {
      const agentId = encodeURIComponent(agent.agent_id);
      const [walletResponse, activityResponse] = await Promise.all([
        request(`/api/wallet-watch?agent_id=${agentId}`),
        request(`/api/wallet-watch/activity?agent_id=${agentId}&limit=200`),
      ]);
      setWallets(Array.isArray(walletResponse.wallets) ? walletResponse.wallets as WatchedNearWallet[] : []);
      setActivity(Array.isArray(activityResponse.activity) ? activityResponse.activity as WatchedNearActivity[] : []);
      setLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load this agent’s wallet activity.');
    } finally {
      setLoading(false);
    }
  };

  const choices: Array<{ value: AgentVerificationStatus; label: string }> = [
    { value: 'verified', label: 'Verify' },
    { value: 'unverified', label: 'Unverified' },
    { value: 'decoy', label: 'Flag decoy' },
  ];

  const setStatus = (nextStatus: AgentVerificationStatus) => {
    if (nextStatus === 'decoy'
      && !window.confirm(`Flag ${agent.agent_id} as a decoy? All future approval attestations for this agent will be blocked.`)) return;
    onVerificationChange(agent.agent_id, nextStatus);
  };

  return <article className="rounded-xl border border-[#e6ebef] bg-[#fbfcfd]">
    <button onClick={() => void toggle()} aria-expanded={open} className="flex w-full items-center justify-between gap-3 p-3 text-left">
      <span className="min-w-0"><b className="block truncate text-[10px]">{agent.agent_name || agent.agent_id}</b><small className="block truncate font-mono text-[8px] text-slate-500">{agent.agent_id}</small></span>
      <span className="flex shrink-0 items-center gap-2"><span className="text-[9px] text-slate-500">Wallet activity</span>{open ? <ChevronDown className="h-3.5 w-3.5"/> : <ChevronRight className="h-3.5 w-3.5"/>}</span>
    </button>
    <div className="border-t border-[#e6ebef] px-3 py-2">
      <p className="mb-1 text-[8px] font-semibold uppercase tracking-wide text-slate-500">Identity status: {status === 'loading' ? 'loading' : status}</p>
      <div className="flex flex-wrap gap-1">
        {choices.map((choice) => <button
          key={choice.value}
          type="button"
          disabled={busy || !verificationLoaded || status === choice.value}
          onClick={() => setStatus(choice.value)}
          className={`rounded-md border px-2 py-1 text-[8px] font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${status === choice.value ? 'border-[#334e68] bg-[#334e68] text-white' : 'border-[#d7dfe6] bg-white text-[#43586b] hover:bg-slate-50'}`}
        >{choice.label}</button>)}
      </div>
      {status === 'decoy' && <p className="mt-2 text-[8px] font-semibold text-rose-800">Approval attestations are blocked for this agent.</p>}
    </div>
    {open && <div className="border-t border-[#e6ebef] px-3 pb-3 pt-2">
      {loading ? <p className="text-[9px] text-slate-500">Loading registered wallets and transactions…</p>
        : error ? <p role="alert" className="text-[9px] text-rose-800">{error}</p>
          : <>
            {wallets.length ? <div className="mb-2 space-y-1">{wallets.map((wallet) => <p key={wallet.id} className="break-all text-[8px] text-slate-600">{wallet.account_id} · {wallet.network} · {wallet.active ? 'watching' : 'inactive'}</p>)}</div>
              : <p className="mb-2 text-[9px] text-slate-500">No registered wallet found for this agent.</p>}
            {activity.length ? <div className="max-h-52 space-y-2 overflow-auto">{activity.map((item) => <div key={item.id} className="rounded-lg border border-[#e6ebef] bg-white p-2">
              <div className="flex justify-between gap-2 text-[8px]"><b>{item.action_kinds.join(', ') || 'NEAR transaction'} · {item.direction}</b><time className="shrink-0 text-slate-500">{new Date(item.observed_at).toLocaleString()}</time></div>
              <p className="mt-1 break-all font-mono text-[8px] text-slate-500">{item.transaction_hash}</p>
              <p className="mt-1 break-all text-[8px] text-slate-500">{item.account_id} · block {item.block_height}</p>
            </div>)}</div> : wallets.length > 0 && <p className="text-[9px] text-slate-500">No wallet transactions have been observed yet. The watcher must be healthy and complete a finalized block poll.</p>}
          </>}
    </div>}
  </article>;
}

export default function AgentActivityBrowser({
  agents,
  request,
  verifications,
  verificationLoaded,
  verificationError,
  busyAgentId,
  onVerificationChange,
}: {
  agents: AgentSummary[];
  request: Request;
  verifications: AgentVerificationRecord[];
  verificationLoaded: boolean;
  verificationError?: string;
  busyAgentId: string;
  onVerificationChange: (agentId: string, status: AgentVerificationStatus) => void;
}) {
  if (!agents.length) return null;
  const byId = new Map(verifications.map((verification) => [verification.agent_id, verification]));
  return <section className="rounded-2xl border border-[#d9e0e8] bg-white p-5 shadow-[0_12px_32px_rgba(20,37,54,.045)]">
    <p className="text-[9px] font-bold uppercase tracking-[.18em] text-[#758397]">Agent verification</p>
    <h2 className="mb-1 mt-1 text-sm font-semibold tracking-tight text-[#172b3d]">Agent identities & transactions</h2>
    <p className="mb-3 text-[9px] text-slate-500">Verification is an operator review. Flagged agents cannot receive approval attestations; other statuses do not change policy decisions.</p>
    {verificationError && <p role="alert" className="mb-3 text-[9px] text-rose-800">{verificationLoaded ? 'Could not refresh saved agent verification decisions; using the last loaded values' : 'Could not load saved agent verification decisions'}: {verificationError}</p>}
    {!verificationLoaded && !verificationError && <p role="status" className="mb-3 text-[9px] text-slate-500">Loading saved agent verification decisions…</p>}
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">{agents.map((agent) => <AgentRow
      key={agent.agent_id}
      agent={agent}
      request={request}
      verification={byId.get(agent.agent_id)}
      verificationLoaded={verificationLoaded}
      busy={busyAgentId === `verification:${agent.agent_id}`}
      onVerificationChange={onVerificationChange}
    />)}</div>
  </section>;
}
