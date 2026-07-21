'use client';

import { AlertTriangle, X } from 'lucide-react';
import { useState } from 'react';

interface ApprovalModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function ApprovalModal({ isOpen, onClose }: ApprovalModalProps) {
  const [isLoading, setIsLoading] = useState(false);

  if (!isOpen) return null;

  const handleAction = async (action: string) => {
    setIsLoading(true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    console.log(`Action: ${action}`);
    setIsLoading(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-slate-900 border-2 border-red-500/50 rounded-lg shadow-2xl max-w-md w-full asguard-glow-red">
        {/* Header */}
        <div className="bg-gradient-to-r from-red-500/10 to-orange-500/10 border-b border-red-500/30 px-6 py-4 flex items-start justify-between">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-6 h-6 text-red-400 mt-0.5 flex-shrink-0" />
            <div>
              <h3 className="text-lg font-bold text-slate-100">Security Violation</h3>
              <p className="text-xs text-slate-400 mt-1">Requires human-in-the-loop approval</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 transition"
            disabled={isLoading}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-6 space-y-4">
          {/* Agent Info */}
          <div>
            <p className="text-xs text-slate-400 uppercase tracking-wide">Agent</p>
            <p className="text-lg font-semibold text-cyan-400 font-mono mt-1">Trader-Bot-01</p>
          </div>

          {/* Flagged Reason */}
          <div>
            <p className="text-xs text-slate-400 uppercase tracking-wide">Flagged Reason</p>
            <p className="text-sm text-red-300 mt-1">
              Attempted trade execution outside scheduled window with unusual transaction size
            </p>
          </div>

          {/* Context Details */}
          <div className="bg-slate-800/50 rounded-lg p-4 border asguard-border space-y-3">
            <div>
              <p className="text-xs text-slate-400 font-mono">TRIGGER_SOURCE</p>
              <p className="text-sm text-slate-200 font-mono">api.external.service</p>
            </div>
            <div>
              <p className="text-xs text-slate-400 font-mono">DEVICE_ID</p>
              <p className="text-sm text-slate-200 font-mono">DEV-2847-9K3L</p>
            </div>
            <div>
              <p className="text-xs text-slate-400 font-mono">IP_ADDRESS</p>
              <p className="text-sm text-red-300 font-mono">203.0.113.42</p>
            </div>
            <div>
              <p className="text-xs text-slate-400 font-mono">TRANSACTION_AMOUNT</p>
              <p className="text-sm text-slate-200 font-mono">$125,000 USD</p>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="border-t border-red-500/30 px-6 py-4 flex gap-3">
          <button
            onClick={() => handleAction('allow-once')}
            disabled={isLoading}
            className="flex-1 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-100 font-semibold rounded transition disabled:opacity-50"
          >
            {isLoading ? 'Processing...' : 'Allow Once'}
          </button>
          <button
            onClick={() => handleAction('allow-session')}
            disabled={isLoading}
            className="flex-1 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-100 font-semibold rounded transition disabled:opacity-50"
          >
            {isLoading ? 'Processing...' : 'Allow Session'}
          </button>
          <button
            onClick={() => handleAction('deny')}
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
