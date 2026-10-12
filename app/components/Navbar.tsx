'use client';

import { Shield } from 'lucide-react';

export default function Navbar() {
  return (
    <nav className="border-b asguard-border bg-slate-950/50 backdrop-blur sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-gradient-to-br from-cyan-500/20 to-purple-500/20 rounded-lg asguard-glow-green">
            <Shield className="w-6 h-6 text-cyan-400" />
          </div>
          <div>
            <div className="text-lg font-bold text-slate-100">PAYGUARD</div>
            <div className="text-xs text-slate-400">Payment & account security monitor</div>
          </div>
        </div>
      </div>
    </nav>
  );
}
