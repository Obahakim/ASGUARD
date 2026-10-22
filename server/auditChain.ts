import { EvaluationResult, RuleViolation, AgentActivityEvent, AsguardPolicy } from './types';
import { ProfileManager } from './profileManager';
import { ContractValidator } from './contractValidator';
import { logger } from './logger';

/**
 * Evaluator applies anomaly rules against a real, time-windowed behavioral profile.
 */
export class Evaluator {
  private profileManager: ProfileManager;
  private contractValidator: ContractValidator;

  constructor(profileManager: ProfileManager, contractValidator: ContractValidator) {
    this.profileManager = profileManager;
    this.contractValidator = contractValidator;
  }

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

    if (!policy.strict_anomaly_detection) {
      logger.debug(`[Evaluator] Anomaly detection disabled for ${activity.agent_id}`);
      return result;
    }

    const profileMature = this.profileManager.isProfileMature(activity.agent_id);
    if (!profileMature) {
      logger.debug(`[Evaluator] Profile not mature for ${activity.agent_id}; enforcing budget/contract checks only`);
    }

    await this.checkUnverifiedContract(activity, metadata, result, policy);
    this.checkBudgetOverrun(activity, metadata, policy, result);

    if (profileMature) {
      await this.checkIPBreach(activity, metadata, policy, result);
      this.checkFrequencySpike(activity, metadata, result);
    }

    result.anomaly_score = Math.min(100, result.rules_triggered.reduce((sum, rule) => sum + rule.score_contribution, 0));

    if (result.hard_blocked || result.anomaly_score >= 70) {
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
      hard_blocked: result.hard_blocked,
    } as Record<string, unknown>);

    return result;
  }

  private async checkIPBreach(
    activity: AgentActivityEvent,
    metadata: { ip_address?: string; device_id?: string },
    policy: AsguardPolicy,
    result: EvaluationResult
  ): Promise<void> {
    if (!policy.device_ip_lock) return;

    const profile = this.profileManager.getProfile(activity.agent_id);
    if (profile.baseline_ips.size === 0 && profile.baseline_devices.size === 0) return;

    if (metadata.ip_address && !profile.baseline_ips.has(metadata.ip_address)) {
      result.rules_triggered.push({
        rule_id: 'ip_breach',
        severity: 'high',
        score_contribution: 35,
        details: {
          new_ip: metadata.ip_address,
          known_ips: Array.from(profile.baseline_ips),
          breach_type: 'unknown_location',
        },
      });
    }

    if (metadata.device_id && !profile.baseline_devices.has(metadata.device_id)) {
      result.rules_triggered.push({
        rule_id: 'ip_breach',
        severity: 'high',
        score_contribution: 30,
        details: {
          new_device: metadata.device_id,
          known_devices: Array.from(profile.baseline_devices),
          breach_type: 'unknown_device',
        },
      });
    }
  }

  private checkBudgetOverrun(
    activity: AgentActivityEvent,
    metadata: { amount_usd?: number },
    policy: AsguardPolicy,
    result: EvaluationResult
  ): void {
    const amount = typeof metadata.amount_usd === 'number' ? metadata.amount_usd : 0;
    if (amount <= 0) return;
    if (amount > policy.max_auto_trade_usd) {
      result.hard_blocked = true;
      result.rules_triggered.push({
        rule_id: 'budget_overrun',
        severity: 'high',
        score_contribution: 80,
        details: {
          amount_usd: amount,
          max_auto_trade_usd: policy.max_auto_trade_usd,
          overage: amount - policy.max_auto_trade_usd,
        },
      });
      logger.warn(`[Rule:BudgetOverrun] Amount $${amount} exceeds limit $${policy.max_auto_trade_usd} for ${activity.agent_id}`);
    }
  }

  private checkFrequencySpike(
    activity: AgentActivityEvent,
    metadata: Record<string, unknown>,
    result: EvaluationResult
  ): void {
    const rate = this.profileManager.getActivityRate(activity.agent_id);
    if (!rate.mature) return;
    if (rate.baseline_rate_per_hour <= 0) return;

    const multiplier = rate.current_rate_per_hour / rate.baseline_rate_per_hour;
    if (multiplier >= 3) {
      result.rules_triggered.push({
        rule_id: 'frequency_spike',
        severity: 'medium',
        score_contribution: 35,
        details: {
          current_rate_per_hour: rate.current_rate_per_hour,
          baseline_rate_per_hour: rate.baseline_rate_per_hour,
          multiplier,
        },
      });
      logger.warn(`[Rule:FrequencySpike] Frequency spike for ${activity.agent_id}: ${multiplier.toFixed(2)}x baseline`);
    }
  }

  private async checkUnverifiedContract(
    activity: AgentActivityEvent,
    metadata: { contract_address?: string },
    result: EvaluationResult,
    policy: AsguardPolicy
  ): Promise<void> {
    if (!metadata.contract_address) return;
    const validation = await this.contractValidator.validateContract(metadata.contract_address);
    if (!validation.is_verified) {
      const contribution = policy.strict_anomaly_detection ? 60 : 35;
      result.rules_triggered.push({
        rule_id: 'unverified_contract',
        severity: 'high',
        score_contribution: contribution,
        details: {
          contract_address: metadata.contract_address,
          verification_type: validation.verification_type,
          trust_score: validation.details?.trust_score ?? 0,
        },
      });
      logger.warn(`[Rule:UnverifiedContract] Unverified contract ${metadata.contract_address} for ${activity.agent_id}`);
    }
  }
}

export default Evaluator;
