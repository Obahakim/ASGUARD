import { ActivityMetadata, AnomalyProfile, AgentActivityEvent } from './types';
import { logger } from './logger';

/**
 * ProfileManager maintains behavioral baselines for each agent
 * Used to detect deviations from normal patterns
 */
export class ProfileManager {
  private profiles: Map<string, AnomalyProfile> = new Map();
  private payerProfiles = new Map<string, { timestamps: number[]; countries: Set<string>; devices: Set<string> }>();
  private readonly MIN_OBSERVATIONS = 5; // Consumer baselines warm up; deterministic merchant risk signals can act immediately.

  /**
   * Get or create agent profile
   */
  getProfile(agentId: string): AnomalyProfile {
    if (!this.profiles.has(agentId)) {
      this.profiles.set(agentId, {
        agent_id: agentId,
        baseline_trade_frequency: 0,
        baseline_avg_amount_usd: 0,
        baseline_amounts: {},
        transaction_counts_by_currency: {},
        baseline_ips: new Set(),
        baseline_devices: new Set(),
        first_seen: new Date(),
        last_updated: new Date(),
        observation_count: 0,
        transaction_count: 0,
        recent_event_timestamps: [],
      });
    }
    return this.profiles.get(agentId)!;
  }

  /**
   * Update profile with new activity
   */
  updateProfile(activity: AgentActivityEvent, metadata: ActivityMetadata): void {
    const profile = this.getProfile(activity.agent_id);

    // Track IP addresses
    if (metadata.ip_address) {
      profile.baseline_ips.add(metadata.ip_address);
    }

    // Track devices
    if (metadata.device_id) {
      profile.baseline_devices.add(metadata.device_id);
    }

    // Update event frequency and transaction value baselines independently.
    if (profile.observation_count === 0) {
      profile.baseline_trade_frequency = 1;
    } else {
      const alpha = 0.3; // Smoothing factor
      profile.baseline_trade_frequency =
        alpha * 1 +
        (1 - alpha) * profile.baseline_trade_frequency;
    }
    if ((metadata.event_type ?? 'transaction') === 'transaction' && (metadata.amount_usd ?? metadata.amount) !== undefined) {
      const amount = metadata.amount_usd ?? metadata.amount ?? 0;
      const currency = (metadata.currency ?? 'USD').toUpperCase();
      const currencyCount = profile.transaction_counts_by_currency[currency] ?? 0;
      profile.baseline_amounts[currency] = currencyCount === 0
        ? amount
        : 0.3 * amount + 0.7 * profile.baseline_amounts[currency];
      profile.transaction_counts_by_currency[currency] = currencyCount + 1;
      if (currency === 'USD') profile.baseline_avg_amount_usd = profile.baseline_amounts[currency];
      profile.transaction_count++;
    }

    profile.observation_count++;
    const eventTime = Date.parse(activity.timestamp) || Date.now();
    profile.recent_event_timestamps = [...profile.recent_event_timestamps.filter((time) => time > eventTime - 5 * 60_000), eventTime];
    if (metadata.event_type === 'password_change') profile.last_password_change_at = eventTime;
    profile.last_updated = new Date();

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
    const profile = this.getProfile(agentId);
    if (profile.observation_count === 0) {
      return 1;
    }
    return Math.max(1, profile.baseline_trade_frequency);
  }

  getRecentEventCount(agentId: string, now = Date.now()): number {
    const profile = this.getProfile(agentId);
    profile.recent_event_timestamps = profile.recent_event_timestamps.filter((time) => time > now - 5 * 60_000);
    return profile.recent_event_timestamps.length;
  }

  hadRecentPasswordChange(agentId: string, now = Date.now()): boolean {
    const changedAt = this.getProfile(agentId).last_password_change_at;
    return changedAt !== undefined && changedAt <= now && now - changedAt <= 15 * 60_000;
  }

  getPayerVelocity(key: string, now = Date.now()): number {
    const profile = this.payerProfiles.get(key);
    if (!profile) return 0;
    profile.timestamps = profile.timestamps.filter((timestamp) => timestamp > now - 10 * 60_000);
    return profile.timestamps.length;
  }

  getPayerCountries(key: string): string[] {
    return Array.from(this.payerProfiles.get(key)?.countries ?? []);
  }

  getPayerDevices(key: string): string[] {
    return Array.from(this.payerProfiles.get(key)?.devices ?? []);
  }

  recordIncomingPayment(metadata: ActivityMetadata, eventTimestamp: string): void {
    const keys = new Set([metadata.instrument_fingerprint?.trim(), metadata.payer_id?.trim()].filter((key): key is string => Boolean(key)));
    if (keys.size === 0) return;
    const timestamp = Date.parse(eventTimestamp) || Date.now();
    for (const key of keys) {
      const profile = this.payerProfiles.get(key) ?? { timestamps: [], countries: new Set<string>(), devices: new Set<string>() };
      profile.timestamps = [...profile.timestamps.filter((value) => value > timestamp - 10 * 60_000), timestamp];
      if (metadata.payer_country) profile.countries.add(metadata.payer_country.toUpperCase());
      if (metadata.payer_device_id) profile.devices.add(metadata.payer_device_id);
      this.payerProfiles.set(key, profile);
    }
  }

  /**
   * Get baseline stats for an agent
   */
  getBaselineStats(agentId: string) {
    const profile = this.getProfile(agentId);
    return {
      trade_frequency: profile.baseline_trade_frequency,
      avg_amount_usd: profile.baseline_avg_amount_usd,
      avg_amount_by_currency: { ...profile.baseline_amounts },
      known_ips: Array.from(profile.baseline_ips),
      known_devices: Array.from(profile.baseline_devices),
      observations: profile.observation_count,
      recent_events_5m: this.getRecentEventCount(agentId),
      mature: this.isProfileMature(agentId),
    };
  }

  /**
   * Reset profile for an agent
   */
  resetProfile(agentId: string): void {
    this.profiles.delete(agentId);
    logger.info(`[ProfileManager] Profile reset for ${agentId}`);
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
      payer_profiles: this.payerProfiles.size,
      mature_profiles: Array.from(this.profiles.values()).filter(p => this.isProfileMature(p.agent_id)).length,
      total_observations: Array.from(this.profiles.values()).reduce((sum, p) => sum + p.observation_count, 0),
      min_observations_required: this.MIN_OBSERVATIONS,
    };
  }
}

export default ProfileManager;
