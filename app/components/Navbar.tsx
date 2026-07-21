'use client';

import { Shield, Wifi } from 'lucide-react';
import { useState } from 'react';

export default function Navbar() {
  const [llmEngine, setLlmEngine] = useState('ollama');

  return (
    <nav className="border-b asguard-border bg-slate-950/50 backdrop-blur sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-6 py-4">
        <div className="flex items-center justify-between gap-8">
          {/* Logo */}
          <div className="flex items-center gap-3">
            <div className="p-2 bg-gradient-to-br from-cyan-500/20 to-purple-500/20 rounded-lg asguard-glow-green">
              <Shield className="w-6 h-6 text-cyan-400" />
            </div>
            <div>
              <div className="text-lg font-bold text-slate-100">ASGUARD</div>
              <div className="text-xs text-slate-400">The Guardian Supervisor</div>
            </div>
          </div>

          {/* Connection Status */}
          <div className="flex-1 flex justify-center">
            <div className="flex items-center gap-2 px-4 py-2 bg-slate-900/50 rounded-lg asguard-border">
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Wifi className="w-4 h-4 text-slate-400" />
                  <div className="absolute inset-0 w-4 h-4 rounded-full bg-green-500 animate-pulse" />
                </div>
                <span className="text-sm text-slate-100">Local Astrid Daemon</span>
              </div>
              <span className="text-xs text-green-400 font-mono">Connected (127.0.0.1:8080)</span>
            </div>
          </div>

          {/* LLM Engine Selector */}
          <div className="flex items-center gap-3">
            <label className="text-sm text-slate-400">LLM Engine:</label>
            <select
              value={llmEngine}
              onChange={(e) => setLlmEngine(e.target.value)}
              className="px-3 py-2 bg-slate-900 border asguard-border text-slate-100 text-sm rounded cursor-pointer hover:bg-slate-800 transition"
            >
              <option value="ollama">Ollama (Local - $0)</option>
              <option value="claude">Claude 3.7 API</option>
              <option value="groq">Groq</option>
            </select>
          </div>
        </div>
      </div>
    </nav>
  );
}
