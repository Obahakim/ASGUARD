/**
 * Asguard HITL (Human-in-the-Loop) Handler
 * Manages security approval requests with terminal prompts and WebSocket responses
 */

import readline from 'readline';
import { HITLResponse, HITLRequestEvent } from './types';
import { logger } from './logger';

interface PendingRequest {
  event: HITLRequestEvent;
  timeout: NodeJS.Timeout;
  resolve: (response: HITLResponse) => void;
  reject: (error: Error) => void;
}

export class HITLHandler {
  private pendingRequests = new Map<string, PendingRequest>();
  private rl: readline.Interface | null = null;
  private requestTimeout = 5 * 60 * 1000; // 5 minutes default

  constructor() {
    this.initializeReadline();
  }

  /**
   * Initialize readline interface for terminal input
   */
  private initializeReadline(): void {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    this.rl.on('close', () => {
      this.rejectAllPending('User closed terminal');
    });
  }

  /**
   * Handle HITL request
   */
  public async handleRequest(
    event: HITLRequestEvent
  ): Promise<HITLResponse> {
    const requestId = event.request_id;

    logger.warn(`[HITL] New security approval request: ${requestId}`, {
      agent_id: event.agent_id,
      incident_type: event.incident_type,
      options: event.action_options,
    });

    return new Promise((resolve, reject) => {
      // Set timeout for this request
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        const response: HITLResponse = {
          request_id: requestId,
          action: 'deny_terminate',
          reason: 'Request expired',
        };
        logger.warn(`[HITL] Request expired: ${requestId}`, response as unknown as Record<string, unknown>);
        resolve(response);
      }, this.requestTimeout);

      // Store pending request
      this.pendingRequests.set(requestId, {
        event,
        timeout,
        resolve,
        reject,
      });

      // Prompt user in terminal
      this.promptUser(event)
        .then((action) => {
          clearTimeout(timeout);
          this.pendingRequests.delete(requestId);

          const response: HITLResponse = {
            request_id: requestId,
            action,
            reason: 'User response',
          };

          logger.success(`[HITL] Request resolved: ${requestId}`, { action } as unknown as Record<string, unknown>);
          resolve(response);
        })
        .catch((error) => {
          clearTimeout(timeout);
          this.pendingRequests.delete(requestId);
          logger.error(`[HITL] Error handling request: ${requestId}`, { error: String(error) });
          reject(error);
        });
    });
  }

  /**
   * Prompt user in terminal for decision
   */
  private promptUser(event: HITLRequestEvent): Promise<HITLResponse['action']> {
    return new Promise((resolve, reject) => {
      if (!this.rl) {
        reject(new Error('Readline interface not initialized'));
        return;
      }

      const questions: string[] = [];
      questions.push('\n' + '='.repeat(70));
      questions.push(`[SECURITY ALERT] Human-in-the-Loop Approval Required`);
      questions.push('='.repeat(70));
      questions.push(`\nRequest ID: ${event.request_id}`);
      questions.push(`Agent ID: ${event.agent_id}`);
      questions.push(`Incident Type: ${event.incident_type}`);
      questions.push(`Expires At: ${event.expires_at}`);

      if (Object.keys(event.context).length > 0) {
        questions.push(`\nContext:`);
        Object.entries(event.context).forEach(([key, value]) => {
          questions.push(`  ${key}: ${JSON.stringify(value)}`);
        });
      }

      questions.push(`\nAvailable Actions:`);
      event.action_options.forEach((action, index) => {
        const displayName = this.formatActionName(action);
        questions.push(`  ${index + 1}) ${displayName}`);
      });
      questions.push('');

      // Display the formatted prompt
      process.stdout.write(questions.join('\n'));

      // Create question with options
      const optionStr = event.action_options
        .map((_, index) => (index + 1).toString())
        .join('/');

      this.rl!.question(
        `\nSelect action [${optionStr}] or (q)uit: `,
        (answer) => {
          const selection = answer.toLowerCase().trim();

          if (selection === 'q') {
            logger.info('[HITL] User quit prompt');
            resolve('deny_terminate');
          } else if (selection === '1') {
            resolve('allow_once');
          } else if (selection === '2') {
            resolve('allow_session');
          } else if (selection === '3') {
            resolve('deny_terminate');
          } else {
            this.rl!.question(
              'Invalid selection. Try again: ',
              (retryAnswer) => {
                // Recursive call for retry
                this.promptUser(event)
                  .then(resolve)
                  .catch(reject);
              }
            );
          }
        }
      );
    });
  }

  /**
   * Format action names for display
   */
  private formatActionName(action: string): string {
    const names: Record<string, string> = {
      allow_once: '✓ Allow Once (one-time approval)',
      allow_session: '✓ Allow Session (approve for this session)',
      deny_terminate: '✗ Deny & Terminate (block and stop agent)',
    };
    return names[action] || action;
  }

  /**
   * Get pending request status
   */
  public getPendingRequest(
    requestId: string
  ): PendingRequest | undefined {
    return this.pendingRequests.get(requestId);
  }

  /**
   * Get all pending requests
   */
  public getPendingRequests(): Map<string, PendingRequest> {
    return new Map(this.pendingRequests);
  }

  /**
   * Reject all pending requests
   */
  private rejectAllPending(reason: string): void {
    this.pendingRequests.forEach((pending, requestId) => {
      clearTimeout(pending.timeout);
      const response: HITLResponse = {
        request_id: requestId,
        action: 'deny_terminate',
        reason,
      };
      pending.resolve(response);
      logger.warn(`[HITL] Request rejected (${reason}): ${requestId}`);
    });
    this.pendingRequests.clear();
  }

  /**
   * Close readline interface
   */
  public close(): void {
    if (this.rl) {
      this.rl.close();
      this.rejectAllPending('Handler closed');
    }
  }
}

// Export singleton instance
export const hitlHandler = new HITLHandler();
