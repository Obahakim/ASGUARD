import { AnomalyProfile, AgentActivityEvent } from './types';
import { logger } from './logger';

/**
 * ProfileManager maintains behavioral baselines for each agent using real time-windowed activity.
 * Minimum observations are required before stronger rules are enforced.
 */
export class ProfileManager {
  private profiles: Map<string, AnomalyProfile> = new Map();
  private readonly MIN_OBSERVATIONS = 5;
  private readonly ACTIVITY_WINDOW_MS = 60 * 60 * 1000;
  private readonly MAX_HISTORY = 500;

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
      });
    }
    return this.profiles.get(agentId)!;
  }

  updateProfile(activity: AgentActivityEvent, metadata: {
    amount_usd?: number;
    ip_address?: string;
    device_id?: string;
  }): void {
    const profile = this.getProfile(activity.agent_id);

    if (metadata.ip_address) profile.baseline_ips.add(metadata.ip_address);
    if (metadata.device_id) profile.baseline_devices.add(metadata.device_id);

    const eventTime = Date.now();
    const history = profile.event_history ?? [];
    history.push({ timestamp: eventTime, amount_usd: metadata.amount_usd ?? 0 });
    if (history.length > this.MAX_HISTORY) {
      history.splice(0, history.length - this.MAX_HISTORY);
    }
    profile.event_history = history;

    const totalAmount = history.reduce((sum, item) => sum + item.amount_usd, 0);
    profile.baseline_avg_amount_usd = history.length > 0 ? totalAmount / history.length : 0;
    const recentWindow = history.filter((entry) => eventTime - entry.timestamp <= this.ACTIVITY_WINDOW_MS).length;
    profile.baseline_trade_frequency = recentWindow;
    profile.observation_count = history.length;
    profile.last_updated = new Date(eventTime);

    logger.debug(`[ProfileManager] Updated ${activity.agent_id}: freq=${profile.baseline_trade_frequency.toFixed(2)}/hr avg=$${profile.baseline_avg_amount_usd.toFixed(2)}`, {
      observations: profile.observation_count,
    } as Record<string, unknown>);
  }

  isProfileMature(agentId: string): boolean {
    const profile = this.getProfile(agentId);
    return profile.observation_count >= this.MIN_OBSERVATIONS;
  }

  getFrequencyMultiplier(agentId: string): number {
    const profile = this.getProfile(agentId);
    const history = profile.event_history ?? [];
    if (history.length === 0) return 1;
    const now = Date.now();
    const currentRate = history.filter((entry) => now - entry.timestamp <= this.ACTIVITY_WINDOW_MS).length;
    const previousWindow = history.filter(
      (entry) => now - entry.timestamp > this.ACTIVITY_WINDOW_MS && now - entry.timestamp <= 2 * this.ACTIVITY_WINDOW_MS
    );
    const baselineRate = previousWindow.length > 0 ? previousWindow.length : Math.max(1, Math.ceil(currentRate / 2));
    return baselineRate > 0 ? currentRate / baselineRate : 1;
  }

  getActivityRate(agentId: string): { current_rate_per_hour: number; baseline_rate_per_hour: number; mature: boolean } {
    const profile = this.getProfile(agentId);
    const history = profile.event_history ?? [];
    const now = Date.now();
    const currentWindow = history.filter((entry) => now - entry.timestamp <= this.ACTIVITY_WINDOW_MS);
    const previousWindow = history.filter(
      (entry) => now - entry.timestamp > this.ACTIVITY_WINDOW_MS && now - entry.timestamp <= 2 * this.ACTIVITY_WINDOW_MS
    );
    const currentRate = currentWindow.length;
    const baselineRate = previousWindow.length > 0 ? previousWindow.length : Math.max(1, Math.ceil(currentRate / 2));
    return {
      current_rate_per_hour: currentRate,
      baseline_rate_per_hour: baselineRate,
      mature: this.isProfileMature(agentId),
    };
  }

  getBaselineStats(agentId: string) {
    const profile = this.getProfile(agentId);
    return {
      trade_frequency: profile.baseline_trade_frequency,
      avg_amount_usd: profile.baseline_avg_amount_usd,
      known_ips: Array.from(profile.baseline_ips),
      known_devices: Array.from(profile.baseline_devices),
      observations: profile.observation_count,
      mature: this.isProfileMature(agentId),
    };
  }

  resetProfile(agentId: string): void {
    this.profiles.delete(agentId);
    logger.info(`[ProfileManager] Profile reset for ${agentId}`);
  }

  getAllProfiles(): Record<string, AnomalyProfile> {
    const result: Record<string, AnomalyProfile> = {};
    this.profiles.forEach((profile, agentId) => {
      result[agentId] = {
        ...profile,
        baseline_ips: new Set(profile.baseline_ips),
        baseline_devices: new Set(profile.baseline_devices),
      };
    });
    return result;
  }

  getStats(): Record<string, unknown> {
    return {
      total_profiles: this.profiles.size,
      mature_profiles: Array.from(this.profiles.values()).filter((p) => this.isProfileMature(p.agent_id)).length,
      total_observations: Array.from(this.profiles.values()).reduce((sum, p) => sum + p.observation_count, 0),
      min_observations_required: this.MIN_OBSERVATIONS,
    };
  }
}

export default ProfileManager;
