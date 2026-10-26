'use client';

import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import type { HITLRequestEvent } from '../../server/types';

interface ApprovalModalProps {
  request: HITLRequestEvent | null;
  onDecide: (action: 'allow_once' | 'allow_session' | 'deny_terminate') => Promise<void>;
}

export default function ApprovalModal({ request, onDecide }: ApprovalModalProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  if (!request) return null;

  const nestedAnomaly = request.context.anomaly && typeof request.context.anomaly === 'object'
    ? request.context.anomaly as Record<string, unknown>
    : undefined;
  const score = typeof request.context.score === 'number'
    ? request.context.score
    : typeof request.context.anomaly_score === 'number'
      ? request.context.anomaly_score
      : typeof nestedAnomaly?.anomaly_score === 'number' ? nestedAnomaly.anomaly_score : undefined;
  const severity = score === undefined ? 'REVIEW' : score >= 90 ? 'CRITICAL' : score >= 70 ? 'HIGH' : score >= 40 ? 'ELEVATED' : 'LOW';
  const severityClass = severity === 'CRITICAL' || severity === 'HIGH'
    ? 'border-red-400/40 bg-red-400/10 text-red-200'
    : severity === 'ELEVATED'
      ? 'border-amber-400/40 bg-amber-400/10 text-amber-200'
      : 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200';
  const preflight = request.context.preflight && typeof request.context.preflight === 'object'
    ? request.context.preflight as Record<string, unknown>
    : undefined;
  const nearIntent = request.context.near_intent && typeof request.context.near_intent === 'object'
    ? request.context.near_intent as Record<string, unknown>
    : undefined;
  const rules = Array.isArray(request.context.rules) ? request.context.rules as Array<Record<string, unknown>> : [];

  const handleAction = async (action: 'allow_once' | 'allow_session' | 'deny_terminate') => {
    setError('');
    setIsLoading(true);
    try { await onDecide(action); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not submit the approval decision.'); }
    finally { setIsLoading(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-slate-900 border-2 border-red-500/50 rounded-lg shadow-2xl max-w-md w-full asguard-glow-red">
        {/* Header */}
        <div className="bg-gradient-to-r from-red-500/10 to-orange-500/10 border-b border-red-500/30 px-6 py-4 flex items-start justify-between">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-6 h-6 text-red-400 mt-0.5 flex-shrink-0" />
            <div>
              <h3 className="text-lg font-bold text-slate-100">Human approval required</h3>
              <p className="text-xs text-slate-400 mt-1">Requires human-in-the-loop approval</p>
            </div>
          </div>
        </div>
        {error && <p role="alert" className="px-6 text-sm text-red-300">{error}</p>}

        {/* Content */}
        <div className="px-6 py-6 space-y-4">
          {/* Agent Info */}
          <div>
            <p className="text-xs text-slate-400 uppercase tracking-wide">Agent</p>
            <p className="text-lg font-semibold text-cyan-400 font-mono mt-1">{request.agent_id}</p>
          </div>

          {/* Flagged Reason */}
          <div>
            <p className="text-xs text-slate-400 uppercase tracking-wide">Flagged Reason</p>
            <p className="text-sm text-red-300 mt-1">
              {request.incident_type}
            </p>
          </div>
          <div className={`inline-flex rounded border px-2.5 py-1 text-xs font-semibold ${severityClass}`}>
            {severity}{score === undefined ? '' : ` · ${score}/100`}
          </div>
          {nearIntent && <div className="grid grid-cols-1 gap-2 rounded border asguard-border bg-slate-800/50 p-3 text-xs sm:grid-cols-2">
            <p><span className="text-slate-400">Amount: </span><span className="break-all text-slate-100">{String(nearIntent.amount ?? 'unknown')} smallest units</span></p>
            <p><span className="text-slate-400">Verified USD: </span><span className="text-slate-100">{typeof request.context.amount_usd === 'number' ? `$${request.context.amount_usd.toFixed(2)}` : 'unavailable'}</span></p>
            <p className="break-all"><span className="text-slate-400">From: </span><span className="text-slate-100">{String(nearIntent.origin_asset ?? 'unknown asset')}</span></p>
            <p className="break-all"><span className="text-slate-400">To: </span><span className="text-slate-100">{String(nearIntent.destination_asset ?? 'unknown asset')}</span></p>
            <p className="break-all sm:col-span-2"><span className="text-slate-400">Recipient: </span><span className="text-slate-100">{String(nearIntent.recipient ?? 'not decoded')}</span></p>
          </div>}
          {rules.length > 0 && <div className="rounded border asguard-border bg-slate-800/50 p-3 text-xs">
            <p className="mb-1 font-semibold uppercase tracking-wide text-slate-400">Triggered rules</p>
            <ul className="list-inside list-disc space-y-1 text-slate-200">{rules.map((rule, index) => <li key={`${String(rule.rule_id ?? 'rule')}-${index}`}>{String(rule.rule_id ?? 'Rule')} · {String(rule.severity ?? 'info')} · +{String(rule.score_contribution ?? 0)}</li>)}</ul>
          </div>}

          {/* Context Details */}
          <div className="max-h-56 overflow-auto rounded-lg border asguard-border bg-slate-800/50 p-4">
            {preflight && <div className="mb-3 rounded border border-cyan-400/30 bg-cyan-400/5 p-3 text-xs">
              <p className="font-semibold uppercase tracking-wide text-cyan-200">Preflight: {String(preflight.status ?? 'unknown')}</p>
              <p className="mt-1 text-slate-300">{String(preflight.kind ?? 'policy evaluation')} · {preflight.checked_at ? new Date(String(preflight.checked_at)).toLocaleString() : 'time unavailable'}</p>
              {Array.isArray(preflight.reasons) && preflight.reasons.length > 0 && <p className={preflight.status === 'blocked' ? 'mt-1 text-red-200' : 'mt-1 text-amber-200'}>{preflight.status === 'blocked' ? 'Policy blocks' : 'Review reasons'}: {preflight.reasons.map(String).join(', ')}</p>}
            </div>}
            <p className="mb-2 text-xs uppercase tracking-wide text-slate-400">Incident context</p>
            <pre className="whitespace-pre-wrap break-words text-xs text-slate-200">{JSON.stringify(request.context, null, 2)}</pre>
            <p className="mt-3 text-xs text-slate-500">Expires {new Date(request.expires_at).toLocaleString()}</p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="border-t border-red-500/30 px-6 py-4 flex gap-3">
          <button
            onClick={() => handleAction('allow_once')}
            disabled={isLoading}
            className="flex-1 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-100 font-semibold rounded transition disabled:opacity-50"
          >
            {isLoading ? 'Processing...' : 'Allow Once'}
          </button>
          <button
            onClick={() => handleAction('allow_session')}
            disabled={isLoading}
            className="flex-1 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-100 font-semibold rounded transition disabled:opacity-50"
          >
            {isLoading ? 'Processing...' : 'Allow Session'}
          </button>
          <button
            onClick={() => handleAction('deny_terminate')}
            disabled={isLoading}
            className="flex-1 px-4 py-2 bg-red-500 hover:bg-red-600 text-white font-semibold rounded transition disabled:opacity-50"
          >
            {isLoading ? 'Processing...' : 'Deny'}
          </button>
        </div>
      </div>
    </div>
  );
}
