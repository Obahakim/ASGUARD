import { EvaluationResult, RuleViolation, AgentActivityEvent, AsguardPolicy } from './types';
import { ProfileManager } from './profileManager';
import { ContractValidator } from './contractValidator';
import { logger } from './logger';

/**
 * Evaluator applies 4-rule anomaly detection scoring
 * Returns 0-100 score with action (silent_pass, warn, halt_and_hitl)
 */
export class Evaluator {
  private profileManager: ProfileManager;
  private contractValidator: ContractValidator;

  constructor(profileManager: ProfileManager, contractValidator: ContractValidator) {
    this.profileManager = profileManager;
    this.contractValidator = contractValidator;
  }

  /**
   * Evaluate agent activity against all rules
   */
  async evaluate(
    activity: AgentActivityEvent,
    metadata: {
      amount_usd?: number;
      ip_address?: string;
      device_id?: string;
      contract_address?: string;
    },
    policy: AsguardPolicy
  ): Promise<EvaluationResult> {
    const result: EvaluationResult = {
      agent_id: activity.agent_id,
      anomaly_score: 0,
      rules_triggered: [],
      action: 'silent_pass',
      confidence: 100,
      timestamp: new Date().toISOString(),
    };

    // Skip if anomaly detection disabled
    if (!policy.strict_anomaly_detection) {
      logger.debug(`[Evaluator] Anomaly detection disabled for ${activity.agent_id}`);
      return result;
    }

    // Skip if profile not mature
    if (!this.profileManager.isProfileMature(activity.agent_id)) {
      logger.debug(`[Evaluator] Profile not mature for ${activity.agent_id}, skipping evaluation`);
      return result;
    }

    // Apply 4 detection rules
    await this.checkIPBreach(activity, metadata, policy, result);
    this.checkBudgetOverrun(activity, metadata, policy, result);
    this.checkFrequencySpike(activity, metadata, result);
    await this.checkUnverifiedContract(activity, metadata, result);

    // Calculate final score and action
    result.anomaly_score = Math.min(100, result.rules_triggered.reduce((sum, r) => sum + r.score_contribution, 0));

    if (result.anomaly_score >= 70) {
      result.action = 'halt_and_hitl';
      result.confidence = 95;
    } else if (result.anomaly_score >= 40) {
      result.action = 'warn';
      result.confidence = 85;
    } else {
      result.action = 'silent_pass';
      result.confidence = 100;
    }

    logger.info(`[Evaluator] Score: ${result.anomaly_score} | Action: ${result.action} | Agent: ${activity.agent_id}`, {
      rules: result.rules_triggered.length,
      confidence: result.confidence,
    } as Record<string, unknown>);

    return result;
  }

  /**
   * Rule 1: IP/Device breach (HIGH severity)
   * Detects logins from unknown locations
   */
  private async checkIPBreach(
    activity: AgentActivityEvent,
    metadata: { ip_address?: string; device_id?: string },
    policy: AsguardPolicy,
    result: EvaluationResult
  ): Promise<void> {
    if (!policy.device_ip_lock || !metadata.ip_address) {
      return;
    }

    const profile = this.profileManager.getProfile(activity.agent_id);
    const isNewIP = !profile.baseline_ips.has(metadata.ip_address);

    if (isNewIP && profile.baseline_ips.size > 0) {
      const violation: RuleViolation = {
        rule_id: 'ip_breach',
        severity: 'high',
        score_contribution: 40,
        details: {
          new_ip: metadata.ip_address,
          known_ips: Array.from(profile.baseline_ips),
          breach_type: 'unknown_location',
        },
      };
      result.rules_triggered.push(violation);
      logger.warn(`[Rule:IP_Breach] Unknown IP ${metadata.ip_address} for ${activity.agent_id}`);
    }

    if (metadata.device_id) {
      const isNewDevice = !profile.baseline_devices.has(metadata.device_id);
      if (isNewDevice && profile.baseline_devices.size > 0) {
        const violation: RuleViolation = {
          rule_id: 'ip_breach',
          severity: 'high',
          score_contribution: 35,
          details: {
            new_device: metadata.device_id,
            known_devices: Array.from(profile.baseline_devices),
            breach_type: 'unknown_device',
          },
        };
        result.rules_triggered.push(violation);
        logger.warn(`[Rule:IP_Breach] Unknown device ${metadata.device_id} for ${activity.agent_id}`);
      }
    }
  }

  /**
   * Rule 2: Budget overrun (HIGH severity)
   * Detects trades exceeding configured max_auto_trade_usd
   */
  private checkBudgetOverrun(
    activity: AgentActivityEvent,
    metadata: { amount_usd?: number },
    policy: AsguardPolicy,
    result: EvaluationResult
  ): void {
    const amount = metadata.amount_usd || 0;

    if (amount > policy.max_auto_trade_usd) {
      const violation: RuleViolation = {
        rule_id: 'budget_overrun',
        severity: 'high',
        score_contribution: 50,
        details: {
          amount: amount,
          max_allowed: policy.max_auto_trade_usd,
          overage_percent: ((amount / policy.max_auto_trade_usd - 1) * 100).toFixed(1),
        },
      };
      result.rules_triggered.push(violation);
      logger.warn(`[Rule:BudgetOverrun] Amount $${amount} exceeds limit $${policy.max_auto_trade_usd}`, {
        agent: activity.agent_id,
      } as Record<string, unknown>);
    }
  }

  /**
   * Rule 3: Frequency spike (MEDIUM severity)
   * Detects trading frequency 300%+ above baseline
   */
  private checkFrequencySpike(
    activity: AgentActivityEvent,
    metadata: Record<string, unknown>,
    result: EvaluationResult
  ): void {
    const multiplier = this.profileManager.getFrequencyMultiplier(activity.agent_id);
    const profile = this.profileManager.getProfile(activity.agent_id);

    // Simulate current frequency (in production, track time windows)
    const currentFrequency = profile.baseline_trade_frequency * 3.5; // Simulate spike

    if (currentFrequency > profile.baseline_trade_frequency * 3) {
      const violation: RuleViolation = {
        rule_id: 'frequency_spike',
        severity: 'medium',
        score_contribution: 30,
        details: {
          current_frequency: currentFrequency.toFixed(2),
          baseline_frequency: profile.baseline_trade_frequency.toFixed(2),
          spike_percent: (((currentFrequency / profile.baseline_trade_frequency - 1) * 100)).toFixed(1),
        },
      };
      result.rules_triggered.push(violation);
      logger.warn(`[Rule:FrequencySpike] Trading frequency spike detected for ${activity.agent_id}`);
    }
  }

  /**
   * Rule 4: Unverified contract (HIGH severity)
   * Detects interaction with contracts not in whitelist
   */
  private async checkUnverifiedContract(
    activity: AgentActivityEvent,
    metadata: { contract_address?: string },
    result: EvaluationResult
  ): Promise<void> {
    if (!metadata.contract_address) {
      return;
    }

    const validation = await this.contractValidator.validateContract(metadata.contract_address);

    if (!validation.is_verified) {
      const violation: RuleViolation = {
        rule_id: 'unverified_contract',
        severity: 'high',
        score_contribution: 45,
        details: {
          contract: metadata.contract_address,
          verification_type: validation.verification_type,
          trust_score: (validation.details as any).trust_score || 0,
        },
      };
      result.rules_triggered.push(violation);
      logger.warn(`[Rule:UnverifiedContract] Unverified contract ${metadata.contract_address} for ${activity.agent_id}`);
    }
  }
}

export default Evaluator;
