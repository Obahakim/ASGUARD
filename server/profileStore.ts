import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PersistedAgentProfile {
  agent_id: string;
  baseline_trade_frequency: number;
  baseline_avg_amount_usd: number;
  baseline_ips: string[];
  baseline_devices: string[];
  first_seen: string;
  last_updated: string;
  observation_count: number;
  event_history: Array<{ timestamp: number; amount_usd: number }>;
  known_chains: string[];
}

export interface ProfilePersistence {
  load(): PersistedAgentProfile[];
  save(profiles: PersistedAgentProfile[]): void;
}

export class JsonProfilePersistence implements ProfilePersistence {
  private readonly filePath: string;

  constructor(filePath = process.env.ASGUARD_AGENT_PROFILES_PATH || path.join(os.homedir(), '.astrid', 'agent_profiles.json')) {
    this.filePath = filePath;
  }

  load(): PersistedAgentProfile[] {
    if (!fs.existsSync(this.filePath)) return [];
    const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('Agent profile store is malformed.');
    return parsed.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Agent profile store contains an invalid record.');
      const profile = value as Partial<PersistedAgentProfile>;
      if (typeof profile.agent_id !== 'string' || !profile.agent_id.trim()
        || typeof profile.baseline_trade_frequency !== 'number' || !Number.isFinite(profile.baseline_trade_frequency)
        || typeof profile.baseline_avg_amount_usd !== 'number' || !Number.isFinite(profile.baseline_avg_amount_usd)
        || !Array.isArray(profile.baseline_ips) || !profile.baseline_ips.every(item => typeof item === 'string')
        || !Array.isArray(profile.baseline_devices) || !profile.baseline_devices.every(item => typeof item === 'string')
        || !Array.isArray(profile.known_chains) || !profile.known_chains.every(item => typeof item === 'string')
        || typeof profile.first_seen !== 'string' || !Number.isFinite(Date.parse(profile.first_seen))
        || typeof profile.last_updated !== 'string' || !Number.isFinite(Date.parse(profile.last_updated))
        || typeof profile.observation_count !== 'number' || !Number.isInteger(profile.observation_count) || profile.observation_count < 0
        || !Array.isArray(profile.event_history)
        || !profile.event_history.every(item => item && Number.isFinite(item.timestamp) && Number.isFinite(item.amount_usd))) {
        throw new Error('Agent profile store contains an invalid record.');
      }
      return profile as PersistedAgentProfile;
    });
  }

  save(profiles: PersistedAgentProfile[]): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(profiles, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
      throw error;
    }
  }
}