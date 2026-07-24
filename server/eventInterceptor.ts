import { Event, EvaluationResult, AnomalyDetectionEvent, HITLRequestEvent } from './types';
import { eventFormatter, terminalHITL } from './terminalView';
import { logger } from './logger';

/**
 * Event Interceptor handles routing and display of events in terminal
 */
export class EventInterceptor {
  private isInitialized = false;
  private hitlInProgress = new Map<string, boolean>();

  /**
   * Initialize event interceptor
   */
  initialize(): void {
    if (this.isInitialized) return;

    console.log('\x1b[36m\x1b[1m╔════════════════════════════════════════════════════╗\x1b[0m');
    console.log('\x1b[36m\x1b[1m║      Asguard - Daemon Security Interface           ║\x1b[0m');
    console.log('\x1b[36m\x1b[1m║      Ready to intercept anomalies and events       ║\x1b[0m');
    console.log('\x1b[36m\x1b[1m╚════════════════════════════════════════════════════╝\x1b[0m');
    console.log('');

    this.isInitialized = true;
  }

  /**
   * Intercept and process an event
   */
  async interceptEvent(event: Event): Promise<void> {
    try {
      switch (event.type) {
        case 'agent_activity':
          this.handleAgentActivity(event as any);
          break;

        case 'anomaly_detected':
          await this.handleAnomalyDetected(event as AnomalyDetectionEvent);
          break;

        case 'hitl_request':
          await this.handleHITLRequest(event as HITLRequestEvent);
          break;

        case 'audit_log':
          this.handleAuditLog(event as any);
          break;

        default:
          eventFormatter.formatAndLog(event);
      }
    } catch (error) {
      logger.error('[EventInterceptor] Error processing event:', {
        error: String(error),
        event_type: event.type,
      });
    }
  }

  /**
   * Handle agent activity event
   */
  private handleAgentActivity(event: any): void {
    eventFormatter.formatAndLog(event);
  }

  /**
   * Handle anomaly detection event
   */
  private async handleAnomalyDetected(event: AnomalyDetectionEvent): Promise<void> {
    const evaluation = {
      agent_id: event.agent_id,
      anomaly_score: event.confidence_score * 100,
      rules_triggered: [],
      action: event.confidence_score > 0.8 ? 'halt_and_hitl' : 'warn',
      confidence: Math.round(event.confidence_score * 100),
      timestamp: event.timestamp,
    } as EvaluationResult;

    // Format the evaluation result
    eventFormatter.formatEvaluation(evaluation);

    // If action is warn, just log
    if (evaluation.action === 'warn') {
      const lines = [
        '',
        '\x1b[33m⚠  WARNING: Anomaly Detected - Logged for Review\x1b[0m',
        `   Agent will proceed, but activity is flagged for audit`,
        '',
      ];
      lines.forEach((line) => console.log(line));
      return;
    }

    // If action is silent_pass, only mention if requested
    if (evaluation.action === 'silent_pass') {
      return; // No output for silent pass
    }
  }

  /**
   * Handle HITL request with interactive prompt
   */
  private async handleHITLRequest(event: HITLRequestEvent): Promise<void> {
    const { request_id, agent_id, incident_type, context } = event;

    // Prevent duplicate prompts
    if (this.hitlInProgress.has(request_id)) {
      return;
    }

    this.hitlInProgress.set(request_id, true);

    try {
      // Show interactive prompt
      const decision = await terminalHITL.promptApproval(
        agent_id,
        incident_type,
        (context as Record<string, unknown>) || {}
      );

      // Log decision
      logger.info(
        `[EventInterceptor] HITL Decision Made`,
        {
          request_id,
          agent_id,
          decision,
        } as unknown as Record<string, unknown>
      );
    } catch (error) {
      logger.error('[EventInterceptor] Error handling HITL request:', {
        error: String(error),
        request_id,
      });
    } finally {
      this.hitlInProgress.delete(request_id);
    }
  }

  /**
   * Handle audit log event
   */
  private handleAuditLog(event: any): void {
    eventFormatter.formatAndLog(event);
  }

  /**
   * Get event history
   */
  getHistory(): string[] {
    return eventFormatter.getHistory();
  }

  /**
   * Export history to file
   */
  exportHistory(filepath: string): void {
    eventFormatter.exportHistory(filepath);
  }

  /**
   * Cleanup
   */
  cleanup(): void {
    terminalHITL.close();
  }
}

// Singleton instance
export const eventInterceptor = new EventInterceptor();
