'use client';

import { LayoutDashboard, Settings, FileText } from 'lucide-react';

interface TabsProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
}

const tabs = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'rules', label: 'Rule Settings', icon: Settings },
  { id: 'logs', label: 'Audit Logs', icon: FileText },
];

export default function Tabs({ activeTab, onTabChange }: TabsProps) {
  return (
    <div className="flex gap-1 border-b asguard-border mb-6 overflow-x-auto">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`flex items-center gap-2 px-4 py-3 border-b-2 transition whitespace-nowrap ${
              isActive
                ? 'border-cyan-500 text-cyan-400 bg-cyan-500/5'
                : 'border-transparent text-slate-400 hover:text-slate-300'
            }`}
          >
            <Icon className="w-4 h-4" />
            <span className="font-medium">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}
