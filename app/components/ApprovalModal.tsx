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

          {/* Context Details */}
          <div className="max-h-56 overflow-auto rounded-lg border asguard-border bg-slate-800/50 p-4">
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
