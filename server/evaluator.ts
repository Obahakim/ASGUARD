import { ActivityMetadata, EvaluationResult, RuleViolation, AgentActivityEvent, AsguardPolicy } from './types';
import { ProfileManager } from './profileManager';
import { logger } from './logger';

/** Four fast, explainable rules run before the optional Jev judgment layer. */
export class Evaluator {
  constructor(private readonly profileManager: ProfileManager) {}

  async evaluate(activity: AgentActivityEvent, metadata: ActivityMetadata, policy: AsguardPolicy): Promise<EvaluationResult> {
    const result: EvaluationResult = {
      agent_id: activity.agent_id, anomaly_score: 0, rules_triggered: [],
      action: 'silent_pass', recommended_action: 'allow', confidence: 0.5, timestamp: new Date().toISOString(),
    };
    if (!policy.strict_anomaly_detection) return result;

    const profile = this.profileManager.getProfile(activity.agent_id);
    const eventType = metadata.event_type ?? activity.event_type ?? 'transaction';
    const amount = metadata.amount_usd ?? metadata.amount;
    const currency = (metadata.currency ?? 'USD').toUpperCase();
    const merchantReceipt = metadata.account_type === 'business' && metadata.event_direction === 'incoming' && eventType === 'transaction';

    if (merchantReceipt) {
      this.evaluateMerchantReceipt(activity, metadata, policy, result, currency, amount, profile.baseline_amounts[currency] ?? 0);
    } else {
      if (!this.profileManager.isProfileMature(activity.agent_id)) return result;

      // Rule 1: an unrecognized IP or device is a strong account takeover signal.
      if (policy.device_ip_lock) {
        const newIp = !!metadata.ip_address && profile.baseline_ips.size > 0 && !profile.baseline_ips.has(metadata.ip_address);
        const newDevice = !!metadata.device_id && profile.baseline_devices.size > 0 && !profile.baseline_devices.has(metadata.device_id);
        if (newIp || newDevice) this.add(result, 'ip_breach', 35, 'high', {
          new_ip: newIp ? metadata.ip_address : undefined, new_device: newDevice ? metadata.device_id : undefined,
          known_ips: Array.from(profile.baseline_ips), known_devices: Array.from(profile.baseline_devices), location: metadata.location,
        });
      }

      // Rule 2: hard policy cap plus deviation from this account's transaction baseline.
      if (eventType === 'transaction' && amount !== undefined) {
        if (currency === 'USD' && amount > policy.max_auto_trade_usd) this.add(result, 'budget_overrun', 45, 'high', {
          amount, max_allowed: policy.max_auto_trade_usd, currency: metadata.currency,
        });
        const baselineAverage = profile.baseline_amounts[currency] ?? 0;
        if (baselineAverage > 0 && amount >= baselineAverage * 4 && amount > 100) {
          this.add(result, 'amount_deviation', 25, 'medium', {
            amount, currency, baseline_average: Number(baselineAverage.toFixed(2)), multiplier: Number((amount / baselineAverage).toFixed(2)),
          });
        }
      }

      // Rule 3: count observed account events in a rolling five-minute window.
      const recentEvents = this.profileManager.getRecentEventCount(activity.agent_id);
      if (recentEvents >= 8) this.add(result, 'frequency_spike', 30, 'medium', { recent_events_5m: recentEvents, limit: 8 });

      // Rule 4: sensitive account changes increase risk, especially before a payment.
      if (eventType === 'password_change' || eventType === 'payout_change') {
        this.add(result, 'account_change', 30, 'high', { event_type: eventType, recommended_action: 'challenge' });
      } else if (eventType === 'transaction' && this.profileManager.hadRecentPasswordChange(activity.agent_id)) {
        this.add(result, 'account_change', 35, 'high', { event_type: eventType, recent_password_change: true });
      }
    }

    result.anomaly_score = Math.min(100, result.rules_triggered.reduce((sum, rule) => sum + rule.score_contribution, 0));
    result.action = result.anomaly_score >= 70 ? 'halt_and_hitl' : result.anomaly_score >= 30 ? 'warn' : 'silent_pass';
    result.recommended_action = result.anomaly_score >= 70 ? 'hold' : result.anomaly_score >= 50 ? 'challenge' : result.anomaly_score >= 25 ? 'notify' : 'allow';
    result.confidence = Math.min(0.99, 0.55 + result.anomaly_score / 250);
    if (merchantReceipt) {
      result.merchant_recommendation = result.recommended_action === 'hold' ? 'decline'
        : result.recommended_action === 'challenge' ? 'challenge'
          : result.recommended_action === 'notify' ? 'accept-with-review' : 'accept';
    }
    logger.info(`[Evaluator] Score: ${result.anomaly_score} | Action: ${result.recommended_action} | Account: ${activity.agent_id}`, { rules: result.rules_triggered.length });
    return result;
  }

  private evaluateMerchantReceipt(
    activity: AgentActivityEvent,
    metadata: ActivityMetadata,
    policy: AsguardPolicy,
    result: EvaluationResult,
    currency: string,
    amount: number | undefined,
    baselineAverage: number,
  ): void {
    const bin = metadata.card_bin?.replace(/\s|-/g, '');
    const highRiskBin = metadata.high_risk_bin === true || (!!bin && (policy.high_risk_bins ?? []).includes(bin));
    if (highRiskBin) this.add(result, 'high_risk_bin', 35, 'high', { card_bin: bin ?? 'provider-flagged' });

    const fingerprint = metadata.instrument_fingerprint?.trim();
    const knownBad = metadata.known_bad_instrument === true
      || (!!fingerprint && (policy.blocked_instrument_fingerprints ?? []).includes(fingerprint));
    if (knownBad) this.add(result, 'known_bad_instrument', 80, 'high', { instrument_match: true });

    // Prefer the stable payer ID for velocity/history across multiple instruments.
    const payerKey = metadata.payer_id?.trim() || fingerprint;
    const payerEvents = payerKey ? this.profileManager.getPayerVelocity(payerKey) : 0;
    if (payerEvents >= 3) this.add(result, 'payer_velocity', 30, 'medium', { payer_transactions_10m: payerEvents + 1, limit: 3 });

    const payerCountry = metadata.payer_country?.trim().toUpperCase();
    const instrumentCountry = metadata.instrument_country?.trim().toUpperCase();
    const historicalCountries = payerKey ? this.profileManager.getPayerCountries(payerKey) : [];
    const countryMismatch = (!!payerCountry && !!instrumentCountry && payerCountry !== instrumentCountry)
      || (!!payerCountry && historicalCountries.length > 0 && !historicalCountries.includes(payerCountry));
    if (countryMismatch) this.add(result, 'geo_mismatch', 30, 'high', {
      payer_country: payerCountry, instrument_country: instrumentCountry,
      previously_seen_payer_countries: historicalCountries,
    });

    const payerDevices = payerKey ? this.profileManager.getPayerDevices(payerKey) : [];
    if (metadata.payer_device_id && payerDevices.length > 0 && !payerDevices.includes(metadata.payer_device_id)) {
      this.add(result, 'payer_device_change', 20, 'medium', { new_payer_device: true, known_payer_devices: payerDevices.length });
    }

    if (amount !== undefined && baselineAverage > 0 && amount >= baselineAverage * 3.5 && amount > 100) {
      this.add(result, 'amount_deviation', 25, 'medium', {
        amount, currency, merchant_baseline_average: Number(baselineAverage.toFixed(2)),
        multiplier: Number((amount / baselineAverage).toFixed(2)),
      });
    }
    logger.debug(`[Evaluator] Merchant receipt evaluated for ${activity.agent_id}`, { findings: result.rules_triggered.length });
  }

  private add(result: EvaluationResult, rule_id: RuleViolation['rule_id'], score_contribution: number, severity: RuleViolation['severity'], details: Record<string, unknown>) {
    result.rules_triggered.push({ rule_id, score_contribution, severity, details });
  }
}

export default Evaluator;
