'use client';

import { useState } from 'react';
import Navbar from './components/Navbar';
import Tabs from './components/Tabs';
import ActivityFeed from './components/ActivityFeed';
import SecurityRules from './components/SecurityRules';
import AnomalyDetection from './components/AnomalyDetection';
import ApprovalModal from './components/ApprovalModal';

export default function Home() {
  const [activeTab, setActiveTab] = useState('overview');
  const [showModal, setShowModal] = useState(false);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <Navbar />

      <div className="max-w-7xl mx-auto px-6 py-8">
        <Tabs activeTab={activeTab} onTabChange={setActiveTab} />

        {/* Overview Tab */}
        {activeTab === 'overview' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Column 1: Activity Feed */}
            <div className="bg-slate-900/50 rounded-lg border asguard-border p-6 backdrop-blur">
              <ActivityFeed />
            </div>

            {/* Column 2: Security Rules */}
            <div className="bg-slate-900/50 rounded-lg border asguard-border p-6 backdrop-blur">
              <SecurityRules />
            </div>

            {/* Column 3: Anomaly Detection */}
            <div className="bg-slate-900/50 rounded-lg border asguard-border p-6 backdrop-blur">
              <AnomalyDetection />
            </div>
          </div>
        )}

        {/* Rule Settings Tab */}
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

        {/* Audit Logs Tab */}
        {activeTab === 'logs' && (
          <div className="bg-slate-900/50 rounded-lg border asguard-border p-8 backdrop-blur">
            <h3 className="text-2xl font-bold text-slate-100 mb-6">Audit Logs</h3>
            <div className="space-y-2">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="p-3 bg-slate-800/50 rounded-lg border asguard-border text-sm text-slate-300 font-mono">
                  [14:32:18] Agent: Trader-Bot-01 | Action: Execute Trade | Status: Allowed | Risk: Low
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Approval Modal */}
      <ApprovalModal isOpen={showModal} onClose={() => setShowModal(false)} />
    </main>
  );
}
