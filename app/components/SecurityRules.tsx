'use client';

import { Sliders } from 'lucide-react';
import { useState } from 'react';

export default function SecurityRules() {
  const [maxBudget, setMaxBudget] = useState(50000);
  const [anomalyDetection, setAnomalyDetection] = useState(true);
  const [deviceLock, setDeviceLock] = useState(true);
  const [remoteTrigger, setRemoteTrigger] = useState(false);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 mb-4">
        <div className="p-2 bg-purple-500/10 rounded-lg">
          <Sliders className="w-5 h-5 text-purple-400" />
        </div>
        <h2 className="text-lg font-semibold text-slate-100">Security Rules</h2>
      </div>

      <div className="space-y-6 flex-1">
        {/* Max Auto-Trade Budget */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-semibold text-slate-200">Max Auto-Trade Budget</label>
            <div className="flex items-center gap-2">
              <span className="text-lg font-mono font-bold text-cyan-400">${maxBudget.toLocaleString()}</span>
              <input
                type="number"
                value={maxBudget}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  if (!isNaN(val) && val > 0) {
                    setMaxBudget(val);
                  }
                }}
                className="w-24 px-2 py-1 bg-slate-800 border asguard-border rounded text-xs text-slate-100 text-right"
                placeholder="Enter limit"
              />
            </div>
          </div>
          <input
            type="range"
            min="1000"
            max="50000"
            step="1000"
            value={maxBudget}
            onChange={(e) => setMaxBudget(Number(e.target.value))}
            className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
          />
          <div className="flex justify-between text-xs text-slate-400 mt-1">
            <span>$1K</span>
            <span>$50K</span>
          </div>
        </div>

        {/* Anomaly Detection Toggle */}
        <div className="flex items-center justify-between p-3 bg-slate-900/50 rounded-lg border asguard-border">
          <div>
            <p className="font-semibold text-slate-100 text-sm">Strict Anomaly Detection</p>
            <p className="text-xs text-slate-400 mt-1">Flag unusual patterns in real-time</p>
          </div>
          <button
            onClick={() => setAnomalyDetection(!anomalyDetection)}
            className={`relative w-12 h-7 rounded-full transition ${
              anomalyDetection ? 'bg-green-500' : 'bg-slate-700'
            }`}
          >
            <div
              className={`absolute top-1 w-5 h-5 bg-white rounded-full transition transform ${
                anomalyDetection ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        {/* Device & IP Lock */}
        <div className="flex items-center justify-between p-3 bg-slate-900/50 rounded-lg border asguard-border">
          <div>
            <p className="font-semibold text-slate-100 text-sm">Device & IP Lock</p>
            <p className="text-xs text-slate-400 mt-1">Restrict to registered devices</p>
          </div>
          <button
            onClick={() => setDeviceLock(!deviceLock)}
            className={`relative w-12 h-7 rounded-full transition ${
              deviceLock ? 'bg-green-500' : 'bg-slate-700'
            }`}
          >
            <div
              className={`absolute top-1 w-5 h-5 bg-white rounded-full transition transform ${
                deviceLock ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        {/* Remote Trigger Protection */}
        <div className="flex items-center justify-between p-3 bg-slate-900/50 rounded-lg border asguard-border">
          <div>
            <p className="font-semibold text-slate-100 text-sm">Remote Trigger Protection</p>
            <p className="text-xs text-slate-400 mt-1">Require manual approval for remote calls</p>
          </div>
          <button
            onClick={() => setRemoteTrigger(!remoteTrigger)}
            className={`relative w-12 h-7 rounded-full transition ${
              remoteTrigger ? 'bg-green-500' : 'bg-slate-700'
            }`}
          >
            <div
              className={`absolute top-1 w-5 h-5 bg-white rounded-full transition transform ${
                remoteTrigger ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>

      <div className="mt-4 pt-4 border-t asguard-border space-y-2">
        <button className="w-full px-3 py-2 bg-cyan-500 hover:bg-cyan-600 text-slate-950 font-semibold text-sm rounded transition">
          Save Rules
        </button>
        <button className="w-full px-3 py-2 bg-slate-900 hover:bg-slate-800 text-slate-100 text-sm rounded transition border asguard-border">
          Reset to Default
        </button>
      </div>
    </div>
  );
}
