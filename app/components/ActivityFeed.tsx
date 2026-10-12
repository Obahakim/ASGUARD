'use client';

import { AlertCircle } from 'lucide-react';
import type { Event } from '../../server/types';

export default function ActivityFeed({ events }: { events: Event[] }) {
  const items = events.filter((event) => ['agent_activity', 'security_violation', 'anomaly_detected'].includes(event.type)).slice(-30).reverse();
  return <div className="h-full flex flex-col">
    <div className="flex items-center gap-2 mb-4"><div className="p-2 bg-cyan-500/10 rounded-lg"><AlertCircle className="w-5 h-5 text-cyan-400" /></div><h2 className="text-lg font-semibold text-slate-100">Observed Agents & Activity</h2></div>
    <div className="space-y-2 flex-1 overflow-y-auto pr-2">{items.length === 0 ? <p className="rounded-lg border asguard-border bg-slate-800/50 p-3 text-sm text-slate-400">No agent activity has been reported on the live bridge.</p> : items.map((event) => <div key={event.id} className="p-3 rounded-lg border asguard-border bg-slate-800/40">
      <div className="flex items-center justify-between gap-3"><span className="text-xs font-mono text-slate-400">{new Date(event.timestamp).toLocaleTimeString()}</span><span className="text-xs font-mono text-cyan-300">{event.type.replaceAll('_', ' ')}</span></div>
      <p className="mt-1 text-sm font-semibold text-slate-100">{'agent_id' in event ? event.agent_id : 'System'}</p>
      <p className="text-sm text-slate-300">{event.type === 'agent_activity' ? event.action : event.type === 'security_violation' ? event.violation_type : event.type === 'anomaly_detected' ? event.anomaly_type : ''}</p>
    </div>)}</div>
  </div>;
}
