'use client';

import { useState } from 'react';
import { useBridgeConnection } from '../hooks/useBridgeConnection';
import Navbar from './components/Navbar';
import Tabs from './components/Tabs';
import ActivityFeed from './components/ActivityFeed';
import SecurityRules from './components/SecurityRules';
import AnomalyDetection from './components/AnomalyDetection';
import ApprovalModal from './components/ApprovalModal';

export default function Home() {
  const [activeTab, setActiveTab] = useState('overview');
  const [showModal, setShowModal] = useState(false);
  const { events, isConnected } = useBridgeConnection();
  const auditEvents = events.filter((event) => event.type === 'audit_log');

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <Navbar />

      <div className="max-w-7xl mx-auto px-6 py-8">
        <Tabs activeTab={activeTab} onTabChange={setActiveTab} />

        {activeTab === 'overview' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="bg-slate-900/50 rounded-lg border asguard-border p-6 backdrop-blur">
              <ActivityFeed />
            </div>

            <div className="bg-slate-900/50 rounded-lg border asguard-border p-6 backdrop-blur">
              <SecurityRules />
            </div>

            <div className="bg-slate-900/50 rounded-lg border asguard-border p-6 backdrop-blur">
              <AnomalyDetection />
            </div>
          </div>
        )}

        {activeTab === 'rules' && (
          <div className="bg-slate-900/50 rounded-lg border asguard-border p-8 backdrop-blur">
            <div className="max-w-2xl">
              <h3 className="text-2xl font-bold text-slate-100 mb-6">Advanced Rule Configuration</h3>
              <div className="space-y-6">
                <div className="p-4 bg-slate-800/50 rounded-lg border asguard-border">
                  <p className="text-slate-300">
                    Configure global security policies, agent whitelisting, and custom threat detection rules.
                  </p>
                </div>
                <button
                  onClick={() => setShowModal(true)}
                  className="px-6 py-2 bg-purple-500 hover:bg-purple-600 text-white font-semibold rounded transition"
                >
                  Demo Approval Modal
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'logs' && (
          <div className="bg-slate-900/50 rounded-lg border asguard-border p-8 backdrop-blur">
            <h3 className="text-2xl font-bold text-slate-100 mb-6">Audit Logs</h3>
            <div className="mb-4 text-sm text-slate-400">
              Live bridge: <span className={isConnected ? 'text-emerald-400' : 'text-amber-400'}>{isConnected ? 'connected' : 'disconnected'}</span>
            </div>
            <div className="flex flex-col gap-2">
              {auditEvents.length === 0 ? (
                <div className="rounded-lg border asguard-border bg-slate-800/50 p-4 text-sm text-slate-400">
                  No audit events received yet. The dashboard is no longer showing fabricated log entries.
                </div>
              ) : auditEvents.slice(-25).reverse().map((event) => (
                <div key={event.id} className="rounded-lg border asguard-border bg-slate-800/50 p-3 text-sm text-slate-300 font-mono">
                  [{new Date(event.timestamp).toLocaleTimeString()}] {event.agent_id ?? 'system'} | {event.action} | {event.status}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <ApprovalModal isOpen={showModal} onClose={() => setShowModal(false)} />
    </main>
  );
}
