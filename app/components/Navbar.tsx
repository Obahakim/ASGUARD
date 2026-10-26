'use client';

import { ShieldCheck } from 'lucide-react';

export default function Navbar() {
  return (
    <nav className="sticky top-0 z-50 border-b asguard-border bg-slate-950/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="rounded-md border border-emerald-400/30 bg-emerald-400/10 p-2">
            <ShieldCheck aria-hidden="true" className="h-5 w-5 text-emerald-300" />
          </div>
          <div>
            <div className="text-base font-bold text-slate-100">ASGUARD</div>
            <div className="text-xs text-slate-400">NEAR Intent pre-sign security</div>
          </div>
        </div>
        <span className="rounded border border-emerald-400/30 px-2.5 py-1 text-xs font-medium text-emerald-200">
          Non-custodial control plane
        </span>
      </div>
    </nav>
  );
}