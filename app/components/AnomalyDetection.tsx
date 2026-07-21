'use client';

import { AlertTriangle, ZapOff, Search } from 'lucide-react';
import { useState } from 'react';

const incidents = [
  {
    id: 1,
    severity: 'high',
    agent: 'Trader-Bot-01',
    alert: 'Triggered from unexpected IP 192.168.x.x',
    time: '14:15',
    details: 'Outside routine schedule - High-value transaction attempted',
  },
  {
    id: 2,
    severity: 'medium',
    agent: 'DeFi-Yield-Agent',
    alert: 'Unusual token swap pattern detected',
    time: '13:42',
    details: 'Volume 3x higher than historical average',
  },
  {
    id: 3,
    severity: 'low',
    agent: 'Portfolio-Monitor',
    alert: 'Multiple API calls in 30 seconds',
    time: '13:28',
    details: 'Potential rate limit issue - monitoring',
  },
];

const getSeverityColor = (severity: string) => {
  switch (severity) {
    case 'high':
      return 'bg-red-500/10 border-red-500/30 text-red-400';
    case 'medium':
      return 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400';
    case 'low':
      return 'bg-blue-500/10 border-blue-500/30 text-blue-400';
    default:
      return 'bg-slate-500/10 border-slate-500/30 text-slate-400';
  }
};

const getSeverityLabel = (severity: string) => {
  return severity.charAt(0).toUpperCase() + severity.slice(1);
};

export default function AnomalyDetection() {
  const [activeIncident, setActiveIncident] = useState<number | null>(null);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 mb-4">
        <div className="p-2 bg-red-500/10 rounded-lg">
          <AlertTriangle className="w-5 h-5 text-red-400" />
        </div>
        <h2 className="text-lg font-semibold text-slate-100">Anomalies & Incidents</h2>
      </div>

      <div className="space-y-2 flex-1 overflow-y-auto pr-2">
        {incidents.map((incident) => (
          <div key={incident.id} className="space-y-0">
            <button
              onClick={() => setActiveIncident(activeIncident === incident.id ? null : incident.id)}
              className={`w-full p-3 rounded-lg border ${getSeverityColor(
                incident.severity
              )} hover:opacity-80 transition text-left`}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-semibold">
                      [{getSeverityLabel(incident.severity)}]
                    </span>
                    <span className="text-sm font-semibold text-slate-100">{incident.agent}</span>
                  </div>
                  <p className="text-sm text-slate-300">{incident.alert}</p>
                </div>
                <span className="text-xs font-mono text-slate-400">{incident.time}</span>
              </div>
            </button>

            {activeIncident === incident.id && (
              <div className="p-3 bg-slate-900/30 rounded-lg border asguard-border text-sm text-slate-300 space-y-3">
                <p className="text-slate-200">
                  <span className="font-semibold">Details:</span> {incident.details}
                </p>
                <div className="flex gap-2">
                  <button className="flex-1 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs rounded transition border asguard-border flex items-center justify-center gap-1">
                    <Search className="w-3 h-3" />
                    Investigate
                  </button>
                  <button className="flex-1 px-3 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-300 text-xs rounded transition border border-red-500/50 flex items-center justify-center gap-1">
                    <ZapOff className="w-3 h-3" />
                    Freeze Agent
                  </button>
                  <button className="flex-1 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs rounded transition border asguard-border">
                    Dismiss
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="mt-4 pt-4 border-t asguard-border">
        <button className="w-full px-3 py-2 bg-slate-900 hover:bg-slate-800 text-slate-100 text-sm rounded transition border asguard-border">
          View Full Audit Log
        </button>
      </div>
    </div>
  );
}
