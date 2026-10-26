import { AnomalyProfile, AgentActivityEvent } from './types';
import { logger } from './logger';
import { JsonProfilePersistence, type PersistedAgentProfile, type ProfilePersistence } from './profileStore';

/**
 * ProfileManager maintains behavioral baselines for each agent
 * Used to detect deviations from normal patterns
 */
export class ProfileManager {
  private profiles: Map<string, AnomalyProfile> = new Map();
  private readonly MIN_OBSERVATIONS = 5; // Minimum activities before anomaly detection
  private readonly WINDOW_MS = 60 * 60 * 1000;

  constructor(private readonly persistence: ProfilePersistence = new JsonProfilePersistence()) {
    for (const stored of persistence.load()) {
      this.profiles.set(stored.agent_id, {
        agent_id: stored.agent_id,
        baseline_trade_frequency: stored.baseline_trade_frequency,
        baseline_avg_amount_usd: stored.baseline_avg_amount_usd,
        baseline_ips: new Set(stored.baseline_ips),
        baseline_devices: new Set(stored.baseline_devices),
        first_seen: new Date(stored.first_seen),
        last_updated: new Date(stored.last_updated),
        observation_count: stored.observation_count,
        event_history: stored.event_history.map(event => ({ ...event })),
        known_chains: new Set(stored.known_chains),
      });
    }
  }

  /**
   * Get or create agent profile
   */
  getProfile(agentId: string): AnomalyProfile {
    if (!this.profiles.has(agentId)) {
      this.profiles.set(agentId, {
        agent_id: agentId,
        baseline_trade_frequency: 0,
        baseline_avg_amount_usd: 0,
        baseline_ips: new Set(),
        baseline_devices: new Set(),
        first_seen: new Date(),
        last_updated: new Date(),
        observation_count: 0,
        event_history: [],
        known_chains: new Set(),
      });
    }
    return this.profiles.get(agentId)!;
  }

  /**
   * Update profile with new activity
   */
  updateProfile(activity: AgentActivityEvent, metadata: {
    amount_usd?: number;
    ip_address?: string;
    device_id?: string;
  }): void {
    const profile = this.getProfile(activity.agent_id);
    if (activity.chain) (profile.known_chains ??= new Set()).add(activity.network ? `${activity.chain}:${activity.network}` : activity.chain);
    else if (activity.network) (profile.known_chains ??= new Set()).add(activity.network);

    // Track IP addresses
    if (metadata.ip_address) {
      profile.baseline_ips.add(metadata.ip_address);
    }

    // Track devices
    if (metadata.device_id) {
      profile.baseline_devices.add(metadata.device_id);
    }

    // Update frequency (exponential moving average)
    if (profile.observation_count === 0) {
      profile.baseline_trade_frequency = 1;
      profile.baseline_avg_amount_usd = metadata.amount_usd || 0;
    } else {
      const alpha = 0.3; // Smoothing factor
      profile.baseline_trade_frequency =
        alpha * 1 +
        (1 - alpha) * profile.baseline_trade_frequency;
      profile.baseline_avg_amount_usd =
        alpha * (metadata.amount_usd || 0) +
        (1 - alpha) * profile.baseline_avg_amount_usd;
    }

    profile.observation_count++;
    const history = profile.event_history ??= [];
    history.push({ timestamp: Date.now(), amount_usd: metadata.amount_usd ?? 0 });
    if (history.length > 500) history.shift();
    profile.last_updated = new Date();
    this.persist();

    logger.debug(`[ProfileManager] Updated ${activity.agent_id}: freq=${profile.baseline_trade_frequency.toFixed(2)}, avg=$${profile.baseline_avg_amount_usd.toFixed(2)}`, {
      observations: profile.observation_count,
    } as Record<string, unknown>);
  }

  /**
   * Check if profile has enough data for anomaly detection
   */
  isProfileMature(agentId: string): boolean {
    const profile = this.getProfile(agentId);
    return profile.observation_count >= this.MIN_OBSERVATIONS;
  }

  /**
   * Calculate frequency multiplier (deviation from baseline)
   */
  getFrequencyMultiplier(agentId: string): number {
    const rates = this.getActivityRate(agentId);
    return rates.baseline_rate_per_hour ? rates.current_rate_per_hour / rates.baseline_rate_per_hour : 1;
  }

  getActivityRate(agentId: string) {
    const history = this.getProfile(agentId).event_history ?? [];
    const now = Date.now();
    return { current_rate_per_hour: history.filter(x => now - x.timestamp <= this.WINDOW_MS).length,
      baseline_rate_per_hour: history.filter(x => now - x.timestamp > this.WINDOW_MS && now - x.timestamp <= 2 * this.WINDOW_MS).length,
      mature: this.isProfileMature(agentId) };
  }

  /**
   * Get baseline stats for an agent
   */
  getBaselineStats(agentId: string) {
    const profile = this.getProfile(agentId);
    return {
      trade_frequency: profile.baseline_trade_frequency,
      avg_amount_usd: profile.baseline_avg_amount_usd,
      known_ips: Array.from(profile.baseline_ips),
      known_devices: Array.from(profile.baseline_devices),
      known_chains: Array.from(profile.known_chains ?? []),
      observations: profile.observation_count,
      mature: this.isProfileMature(agentId),
    };
  }

  /**
   * Reset profile for an agent
   */
  resetProfile(agentId: string): void {
    this.profiles.delete(agentId);
    this.persist();
    logger.info(`[ProfileManager] Profile reset for ${agentId}`);
  }

  private persist(): void {
    const profiles: PersistedAgentProfile[] = [...this.profiles.values()].map(profile => ({
      agent_id: profile.agent_id,
      baseline_trade_frequency: profile.baseline_trade_frequency,
      baseline_avg_amount_usd: profile.baseline_avg_amount_usd,
      baseline_ips: [...profile.baseline_ips],
      baseline_devices: [...profile.baseline_devices],
      first_seen: profile.first_seen.toISOString(),
      last_updated: profile.last_updated.toISOString(),
      observation_count: profile.observation_count,
      event_history: (profile.event_history ?? []).map(event => ({ ...event })),
      known_chains: [...(profile.known_chains ?? [])],
    }));
    this.persistence.save(profiles);
  }

  /**
   * Get all profiles (for export/monitoring)
   */
  getAllProfiles(): Record<string, AnomalyProfile> {
    const result: Record<string, AnomalyProfile> = {};
    this.profiles.forEach((profile, agentId) => {
      result[agentId] = {
        ...profile,
        baseline_ips: Array.from(profile.baseline_ips) as unknown as Set<string>,
        baseline_devices: Array.from(profile.baseline_devices) as unknown as Set<string>,
      };
    });
    return result;
  }

  /**
   * Get profile manager statistics
   */
  getStats(): Record<string, unknown> {
    return {
      total_profiles: this.profiles.size,
      mature_profiles: Array.from(this.profiles.values()).filter(p => this.isProfileMature(p.agent_id)).length,
      total_observations: Array.from(this.profiles.values()).reduce((sum, p) => sum + p.observation_count, 0),
      min_observations_required: this.MIN_OBSERVATIONS,
    };
  }
}

export default ProfileManager;
