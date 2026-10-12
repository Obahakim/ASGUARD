'use client';

import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import type { Event } from '../../server/types';

export default function AnomalyDetection({ events }: { events: Event[] }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const incidents = events.filter((event) => event.type === 'anomaly_detected' || event.type === 'security_violation').slice(-20).reverse();
  return <div className="h-full flex flex-col">
    <div className="flex items-center gap-2 mb-4"><div className="p-2 bg-red-500/10 rounded-lg"><AlertTriangle className="w-5 h-5 text-red-400" /></div><h2 className="text-lg font-semibold text-slate-100">Anomalies & Incidents</h2></div>
    <div className="space-y-2 flex-1 overflow-y-auto pr-2">{incidents.length === 0 ? <p className="rounded-lg border asguard-border bg-slate-800/50 p-3 text-sm text-slate-400">No anomaly or security incident events have been reported.</p> : incidents.map((incident) => <div key={incident.id} className="rounded-lg border border-red-500/20 bg-red-500/5">
      <button onClick={() => setActiveId(activeId === incident.id ? null : incident.id)} className="w-full p-3 text-left"><div className="flex items-center justify-between"><span className="text-xs font-semibold text-red-300">{incident.type === 'anomaly_detected' ? 'ANOMALY' : incident.severity.toUpperCase()}</span><span className="text-xs text-slate-400">{new Date(incident.timestamp).toLocaleTimeString()}</span></div><p className="mt-1 text-sm font-semibold text-slate-100">{incident.agent_id}</p><p className="text-sm text-slate-300">{incident.type === 'anomaly_detected' ? incident.anomaly_type : incident.violation_type}</p></button>
      {activeId === incident.id && <pre className="max-h-48 overflow-auto border-t asguard-border p-3 text-xs text-slate-300 whitespace-pre-wrap break-words">{JSON.stringify(incident.type === 'anomaly_detected' ? incident.details : incident.context, null, 2)}</pre>}
    </div>)}</div>
  </div>;
}
