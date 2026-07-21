import { AgentActivityEvent, EvaluationResult, AsguardPolicy, AnomalyDetectionEvent } from './types';
import { ProfileManager } from './profileManager';
import { Evaluator } from './evaluator';
import contractValidator from './contractValidator';
import AuditChain from './auditChain';
import { logger } from './logger';

/**
 * AnomalyEngine orchestrates the complete anomaly detection pipeline
 * Integrates ProfileManager, Evaluator, ContractValidator, and AuditChain
 */
export class AnomalyEngine {
  private profileManager: ProfileManager;
  private evaluator: Evaluator;

  constructor() {
    this.profileManager = new ProfileManager();
    this.evaluator = new Evaluator(this.profileManager, contractValidator);
  }

  /**
   * Process an agent activity event through the detection pipeline
   */
  async processActivity(
    activity: AgentActivityEvent,
    metadata: {
      amount_usd?: number;
      ip_address?: string;
      device_id?: string;
      contract_address?: string;
    },
    policy: AsguardPolicy
  ): Promise<{
    evaluation: EvaluationResult;
    should_trigger_hitl: boolean;
    anomaly_event?: AnomalyDetectionEvent;
  }> {
    logger.debug(`[AnomalyEngine] Processing activity from ${activity.agent_id}: ${activity.action}`);

    // Step 1: Update agent profile with this activity
    this.profileManager.updateProfile(activity, metadata);

    // Step 2: Run anomaly evaluation
    const evaluation = await this.evaluator.evaluate(activity, metadata, policy);

    // Step 3: Add to audit chain
    const auditEntry = AuditChain.addEntry(
      activity.id,
      activity.agent_id,
      activity.action,
      evaluation.anomaly_score
    );

    logger.info(`[AnomalyEngine] Activity processed - Score: ${evaluation.anomaly_score}, Action: ${evaluation.action}`);

    // Step 4: Determine if HITL should be triggered
    const shouldTriggerHitl = evaluation.action === 'halt_and_hitl';

    // Step 5: Create anomaly event if score > 0
    let anomalyEvent: AnomalyDetectionEvent | undefined;
    if (evaluation.anomaly_score > 0) {
      anomalyEvent = {
        type: 'anomaly_detected',
        timestamp: new Date().toISOString(),
        id: `anomaly_${Date.now()}`,
        agent_id: activity.agent_id,
        anomaly_type: evaluation.rules_triggered.map(r => r.rule_id).join(','),
        confidence_score: evaluation.confidence,
        details: {
          score: evaluation.anomaly_score,
          action: evaluation.action,
          rules: evaluation.rules_triggered,
          audit_entry: auditEntry.sequence_number,
          metadata,
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
      audit_chain: AuditChain.getStats(),
      contracts: contractValidator.getStats(),
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
    const valid = AuditChain.verifyChainIntegrity();
    if (!valid) {
      logger.error('[AnomalyEngine] Audit chain integrity check failed');
    }
    return valid;
  }

  /**
   * Export audit trail for compliance
   */
  exportAuditTrail() {
    return AuditChain.exportChain();
  }
}

export default AnomalyEngine;
