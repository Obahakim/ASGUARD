import { ActivityMetadata, AgentActivityEvent, EvaluationResult, AsguardPolicy, AnomalyDetectionEvent } from './types';
import { ProfileManager } from './profileManager';
import { Evaluator } from './evaluator';
import contractValidator from './contractValidator';
import { AuditChain } from './auditChain';
import { logger } from './logger';
import { assessWithJev, getJevStatus } from './jevClient';

/**
 * AnomalyEngine orchestrates the complete anomaly detection pipeline
 * Integrates ProfileManager, Evaluator, ContractValidator, and AuditChain
 */
export class AnomalyEngine {
  private profileManager: ProfileManager;
  private evaluator: Evaluator;
  private auditChain: AuditChain;

  constructor() {
    this.profileManager = new ProfileManager();
    this.evaluator = new Evaluator(this.profileManager);
    this.auditChain = new AuditChain();
  }

  /**
   * Process an agent activity event through the detection pipeline
   */
  async processActivity(
    activity: AgentActivityEvent,
    metadata: ActivityMetadata,
    policy: AsguardPolicy
  ): Promise<{
    evaluation: EvaluationResult;
    should_trigger_hitl: boolean;
    anomaly_event?: AnomalyDetectionEvent;
  }> {
    logger.debug(`[AnomalyEngine] Processing activity from ${activity.agent_id}: ${activity.action}`);

    // Score against the account's prior state before adding this event to its baseline.
    const evaluation = await this.evaluator.evaluate(activity, metadata, policy);

    // Jev adds calibrated, nuanced judgments after deterministic rules; provider failure is non-fatal.
    const payerKey = metadata.payer_id?.trim() || metadata.instrument_fingerprint?.trim();
    const baseline = {
      ...this.profileManager.getBaselineStats(activity.agent_id),
      known_payer_devices: payerKey ? this.profileManager.getPayerDevices(payerKey) : [],
    };
    evaluation.jev = await assessWithJev(activity, metadata, baseline, evaluation);
    if (evaluation.jev.status === 'assessed' && evaluation.jev.fraud_probability !== undefined) {
      const ruleScore = evaluation.anomaly_score;
      const jevRisk = Math.max(
        evaluation.jev.fraud_probability,
        evaluation.jev.chargeback_probability ?? 0,
        evaluation.jev.instrument_high_risk_probability ?? 0,
      );
      const aiScore = jevRisk * 100;
      evaluation.anomaly_score = Math.round(ruleScore * 0.65 + aiScore * 0.35);
      // Keep explicit rule hits and Jev's action in the final policy decision.
      type RiskAction = NonNullable<EvaluationResult['recommended_action']>;
      const actionRank: Record<RiskAction, number> = { allow: 0, notify: 1, challenge: 2, hold: 3 };
      const scoreAction: RiskAction = evaluation.anomaly_score >= 70 ? 'hold' : evaluation.anomaly_score >= 50 ? 'challenge' : evaluation.anomaly_score >= 25 ? 'notify' : 'allow';
      const ruleAction: RiskAction = ruleScore >= 70 ? 'hold' : ruleScore >= 50 ? 'challenge' : ruleScore >= 25 ? 'notify' : 'allow';
      const aiAction: RiskAction = evaluation.jev.recommended_action ?? 'allow';
      const chosen = [ruleAction, scoreAction, aiAction].reduce<RiskAction>((safest, action) => actionRank[action] > actionRank[safest] ? action : safest, 'allow');
      evaluation.recommended_action = chosen;
      if (metadata.account_type === 'business' && metadata.event_direction === 'incoming' && (metadata.event_type ?? activity.event_type) === 'transaction') {
        evaluation.merchant_recommendation = chosen === 'hold' ? 'decline'
          : chosen === 'challenge' ? 'challenge'
            : chosen === 'notify' ? 'accept-with-review' : 'accept';
      }
      evaluation.action = chosen === 'hold' ? 'halt_and_hitl' : chosen === 'notify' || chosen === 'challenge' ? 'warn' : 'silent_pass';
      evaluation.confidence = Math.round((evaluation.confidence * 0.5 + (evaluation.jev.confidence ?? 0.5) * 0.5) * 100) / 100;
    }

    this.profileManager.updateProfile(activity, metadata);
    if (metadata.account_type === 'business' && metadata.event_direction === 'incoming' && (metadata.event_type ?? activity.event_type) === 'transaction') {
      this.profileManager.recordIncomingPayment(metadata, activity.timestamp);
    }

    // Step 3: Add to audit chain
    const auditEntry = this.auditChain.addEntry(
      activity.id,
      activity.agent_id,
      `${metadata.event_type ?? activity.event_type ?? 'activity'}:${evaluation.recommended_action ?? evaluation.action}`,
      evaluation.anomaly_score
    );

    logger.info(`[AnomalyEngine] Activity processed - Score: ${evaluation.anomaly_score}, Action: ${evaluation.action}`);

    // Step 4: Determine if HITL should be triggered
    const shouldTriggerHitl = evaluation.recommended_action === 'hold' || evaluation.recommended_action === 'challenge';

    // Step 5: Create anomaly event if score > 0
    let anomalyEvent: AnomalyDetectionEvent | undefined;
    if (evaluation.anomaly_score > 0 || evaluation.recommended_action !== 'allow') {
      anomalyEvent = {
        type: 'anomaly_detected',
        timestamp: new Date().toISOString(),
        id: `anomaly_${Date.now()}`,
        agent_id: activity.agent_id,
        anomaly_type: evaluation.rules_triggered.map(r => r.rule_id).join(',') || 'jev_risk_assessment',
        confidence_score: evaluation.confidence,
        details: {
          score: evaluation.anomaly_score,
          action: evaluation.action,
          rules: evaluation.rules_triggered,
          audit_entry: auditEntry.sequence_number,
          metadata,
          jev: evaluation.jev,
          recommended_action: evaluation.recommended_action,
          merchant_recommendation: evaluation.merchant_recommendation,
        },
      };
    }

    return {
      evaluation,
      should_trigger_hitl: shouldTriggerHitl,
      anomaly_event: anomalyEvent,
    };
  }

  /**
   * Get engine diagnostics
   */
  getDiagnostics() {
    return {
      profiles: this.profileManager.getStats(),
      audit_chain: this.auditChain.getStats(),
      contracts: contractValidator.getStats(),
      jev: getJevStatus(),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get agent baseline profile
   */
  getAgentProfile(agentId: string) {
    return this.profileManager.getBaselineStats(agentId);
  }

  /**
   * Reset agent profile (after alert resolution)
   */
  resetAgentProfile(agentId: string): void {
    this.profileManager.resetProfile(agentId);
    logger.info(`[AnomalyEngine] Profile reset for ${agentId}`);
  }

  /**
   * Verify audit chain integrity
   */
  verifyAuditChain(): boolean {
    const valid = this.auditChain.verifyChainIntegrity();
    if (!valid) {
      logger.error('[AnomalyEngine] Audit chain integrity check failed');
    }
    return valid;
  }

  /**
   * Export audit trail for compliance
   */
  exportAuditTrail() {
    return this.auditChain.exportChain();
  }
}

export default AnomalyEngine;
