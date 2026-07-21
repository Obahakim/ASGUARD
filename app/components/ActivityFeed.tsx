'use client';

import { AlertCircle, CheckCircle, Clock } from 'lucide-react';

const activities = [
  {
    id: 1,
    timestamp: '14:32:18',
    agent: 'Trader-Bot-01',
    action: 'Execute Trade Order',
    risk: 'Low',
    status: 'Allowed',
    color: 'bg-green-500/10 border-green-500/30',
  },
  {
    id: 2,
    timestamp: '14:31:45',
    agent: 'DeFi-Yield-Agent',
    action: 'Swap Tokens',
    risk: 'Medium',
    status: 'Audited',
    color: 'bg-yellow-500/10 border-yellow-500/30',
  },
  {
    id: 3,
    timestamp: '14:30:12',
    agent: 'Portfolio-Monitor',
    action: 'Rebalance Portfolio',
    risk: 'Low',
    status: 'Allowed',
    color: 'bg-green-500/10 border-green-500/30',
  },
  {
    id: 4,
    timestamp: '14:28:33',
    agent: 'Trader-Bot-01',
    action: 'Fetch Market Data',
    risk: 'Low',
    status: 'Allowed',
    color: 'bg-green-500/10 border-green-500/30',
  },
];

const getRiskColor = (risk: string) => {
  switch (risk) {
    case 'Low':
      return 'text-green-400';
    case 'Medium':
      return 'text-yellow-400';
    case 'High':
      return 'text-red-400';
    default:
      return 'text-slate-400';
  }
};

const getStatusIcon = (status: string) => {
  return status === 'Allowed' ? (
    <CheckCircle className="w-4 h-4 text-green-400" />
  ) : (
    <Clock className="w-4 h-4 text-yellow-400" />
  );
};

export default function ActivityFeed() {
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 mb-4">
        <div className="p-2 bg-cyan-500/10 rounded-lg">
          <AlertCircle className="w-5 h-5 text-cyan-400" />
        </div>
        <h2 className="text-lg font-semibold text-slate-100">Observed Agents & Activity</h2>
      </div>

      <div className="space-y-2 flex-1 overflow-y-auto pr-2">
        {activities.map((activity) => (
          <div
            key={activity.id}
            className={`p-3 rounded-lg border ${activity.color} hover:bg-slate-900/50 transition cursor-pointer`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-mono text-slate-400">{activity.timestamp}</span>
                  <span className="text-sm font-semibold text-slate-100 truncate">{activity.agent}</span>
                </div>
                <p className="text-sm text-slate-300">{activity.action}</p>
              </div>
              <div className="flex items-center gap-2">
                {getStatusIcon(activity.status)}
                <span className={`text-xs font-mono ${getRiskColor(activity.risk)}`}>{activity.risk}</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 pt-4 border-t asguard-border">
        <button className="w-full px-3 py-2 bg-slate-900 hover:bg-slate-800 text-slate-100 text-sm rounded transition border asguard-border">
          View All Logs
        </button>
      </div>
    </div>
  );
}
