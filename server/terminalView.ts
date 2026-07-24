import * as readline from 'readline';
import { logger } from './logger';
import { Event, EvaluationResult, RuleViolation } from './types';

/**
 * Color codes for terminal output
 */
const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

/**
 * Format risk level with color
 */
export function formatRiskTag(riskLevel: string): string {
  const riskLower = riskLevel.toLowerCase();
  switch (riskLower) {
    case 'low':
      return `${COLORS.green}●${COLORS.reset} LOW`;
    case 'medium':
      return `${COLORS.yellow}●${COLORS.reset} MEDIUM`;
    case 'high':
      return `${COLORS.red}●${COLORS.reset} HIGH`;
    case 'critical':
      return `${COLORS.red}${COLORS.bright}●${COLORS.reset} CRITICAL`;
    default:
      return riskLevel;
  }
}

/**
 * Format anomaly score with color gradient
 */
export function formatAnomalyScore(score: number): string {
  if (score < 40) {
    return `${COLORS.green}${score}${COLORS.reset}`;
  } else if (score < 70) {
    return `${COLORS.yellow}${score}${COLORS.reset}`;
  } else {
    return `${COLORS.red}${COLORS.bright}${score}${COLORS.reset}`;
  }
}

/**
 * Format rule violation with details
 */
export function formatRuleViolation(rule: RuleViolation, index: number): string {
  const severityColor = rule.severity === 'high' ? COLORS.red : COLORS.yellow;
  const lines: string[] = [];

  lines.push(`  ${index + 1}. ${severityColor}${rule.rule_id}${COLORS.reset}`);
  lines.push(`     Severity: ${severityColor}${rule.severity.toUpperCase()}${COLORS.reset}`);
  lines.push(`     Score: +${rule.score_contribution}`);

  if (Object.keys(rule.details).length > 0) {
    lines.push(`     Details:`);
    Object.entries(rule.details).forEach(([key, value]) => {
      lines.push(`       ${key}: ${JSON.stringify(value)}`);
    });
  }

  return lines.join('\n');
}

/**
 * Format evaluation result for display
 */
export function formatEvaluationResult(result: EvaluationResult): string[] {
  const lines: string[] = [];
  const actionColor =
    result.action === 'silent_pass'
      ? COLORS.green
      : result.action === 'warn'
        ? COLORS.yellow
        : COLORS.red;

  lines.push('');
  lines.push(
    `${COLORS.bright}Anomaly Detection Result${COLORS.reset} [${result.timestamp.split('T')[1].split('.')[0]}]`
  );
  lines.push(
    `${'─'.repeat(60)}`
  );
  lines.push(`Agent: ${result.agent_id}`);
  lines.push(`Score: ${formatAnomalyScore(result.anomaly_score)}/100`);
  lines.push(`Action: ${actionColor}${result.action.toUpperCase()}${COLORS.reset}`);
  lines.push(`Confidence: ${result.confidence}%`);

  if (result.rules_triggered.length > 0) {
    lines.push('');
    lines.push(`${COLORS.bright}Rules Triggered (${result.rules_triggered.length})${COLORS.reset}:`);
    result.rules_triggered.forEach((rule, index) => {
      lines.push(formatRuleViolation(rule, index));
    });
  }

  lines.push(`${'─'.repeat(60)}`);
  lines.push('');

  return lines;
}

/**
 * Format generic event for terminal display
 */
export function formatEvent(event: Event): string[] {
  const lines: string[] = [];
  const timestamp = event.timestamp.split('T')[1].split('.')[0];

  switch (event.type) {
    case 'agent_activity': {
      const evt = event as any;
      lines.push(
        `[${timestamp}] ${COLORS.blue}ACTIVITY${COLORS.reset} ${evt.agent_name || evt.agent_id}`
      );
      lines.push(`  Action: ${evt.action}`);
      lines.push(`  Risk: ${formatRiskTag(evt.risk_level)}`);
      break;
    }
    case 'anomaly_detected': {
      const evt = event as any;
      lines.push(
        `[${timestamp}] ${COLORS.red}${COLORS.bright}ANOMALY${COLORS.reset} ${evt.agent_id}`
      );
      lines.push(`  Score: ${formatAnomalyScore(evt.anomaly_score)}/100`);
      lines.push(`  Action: ${evt.action === 'halt_and_hitl' ? 'HALT & HITL' : evt.action}`);
      break;
    }
    case 'hitl_request': {
      const evt = event as any;
      lines.push(
        `[${timestamp}] ${COLORS.magenta}${COLORS.bright}HITL REQUEST${COLORS.reset} ${evt.agent_id}`
      );
      lines.push(`  Type: ${evt.incident_type}`);
      lines.push(`  Expires: ${new Date(evt.expires_at).toLocaleTimeString()}`);
      break;
    }
    case 'audit_log': {
      const evt = event as any;
      lines.push(
        `[${timestamp}] ${COLORS.cyan}AUDIT${COLORS.reset} ${evt.action} (${evt.status})`
      );
      lines.push(`  Agent: ${evt.agent_id}`);
      lines.push(`  Resource: ${evt.resource}`);
      break;
    }
    default:
      lines.push(`[${timestamp}] ${event.type.toUpperCase()}`);
  }

  return lines;
}

/**
 * Terminal UI for HITL prompts
 */
export class TerminalHITL {
  private rl: readline.Interface | null = null;

  /**
   * Show interactive HITL prompt
   */
  async promptApproval(
    agentId: string,
    violationType: string,
    context: Record<string, unknown>
  ): Promise<'allow_once' | 'allow_session' | 'deny_terminate'> {
    return new Promise((resolve) => {
      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      console.log('');
      console.log(`${COLORS.magenta}${COLORS.bright}╔════════════════════════════════════════════════════╗${COLORS.reset}`);
      console.log(`${COLORS.magenta}${COLORS.bright}║  HUMAN-IN-THE-LOOP APPROVAL REQUIRED                ║${COLORS.reset}`);
      console.log(`${COLORS.magenta}${COLORS.bright}╚════════════════════════════════════════════════════╝${COLORS.reset}`);
      console.log('');
      console.log(`${COLORS.bright}Agent:${COLORS.reset} ${agentId}`);
      console.log(`${COLORS.bright}Violation:${COLORS.reset} ${violationType}`);
      console.log('');

      if (context && Object.keys(context).length > 0) {
        console.log(`${COLORS.bright}Context:${COLORS.reset}`);
        Object.entries(context).forEach(([key, value]) => {
          console.log(`  ${key}: ${JSON.stringify(value)}`);
        });
        console.log('');
      }

      console.log(`${COLORS.yellow}Options:${COLORS.reset}`);
      console.log(`  ${COLORS.green}1${COLORS.reset} - Allow Once     (proceed with this action only)`);
      console.log(
        `  ${COLORS.yellow}2${COLORS.reset} - Allow Session (allow similar actions for this session)`
      );
      console.log(`  ${COLORS.red}3${COLORS.reset} - Deny & Halt   (block this action and terminate)`);
      console.log('');

      this.promptForInput(resolve);
    });
  }

  /**
   * Recursively prompt user until valid input
   */
  private promptForInput(
    resolve: (value: 'allow_once' | 'allow_session' | 'deny_terminate') => void
  ): void {
    if (!this.rl) return;

    this.rl.question(`${COLORS.bright}Your decision (1-3):${COLORS.reset} `, (answer) => {
      const choice = answer.trim().toLowerCase();

      if (choice === '1' || choice === 'allow_once' || choice === 'a') {
        this.rl?.close();
        console.log(`${COLORS.green}✓ Decision: Allow Once${COLORS.reset}\n`);
        resolve('allow_once');
      } else if (choice === '2' || choice === 'allow_session' || choice === 's') {
        this.rl?.close();
        console.log(`${COLORS.yellow}✓ Decision: Allow Session${COLORS.reset}\n`);
        resolve('allow_session');
      } else if (choice === '3' || choice === 'deny_terminate' || choice === 'd') {
        this.rl?.close();
        console.log(`${COLORS.red}✓ Decision: Deny & Halt${COLORS.reset}\n`);
        resolve('deny_terminate');
      } else {
        console.log(`${COLORS.red}Invalid input. Please enter 1, 2, or 3.${COLORS.reset}`);
        this.promptForInput(resolve);
      }
    });
  }

  /**
   * Close readline interface
   */
  close(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}

/**
 * Event formatter with streaming support
 */
export class EventFormatter {
  private history: string[] = [];
  private maxHistory: number = 1000;

  /**
   * Format and display event
   */
  formatAndLog(event: Event): void {
    const lines = formatEvent(event);

    lines.forEach((line) => {
      console.log(line);
      this.history.push(line);
    });

    // Trim history
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
  }

  /**
   * Format evaluation result
   */
  formatEvaluation(result: EvaluationResult): void {
    const lines = formatEvaluationResult(result);

    lines.forEach((line) => {
      console.log(line);
      this.history.push(line);
    });

    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
  }

  /**
   * Get full history
   */
  getHistory(): string[] {
    return [...this.history];
  }

  /**
   * Export history to file
   */
  exportHistory(filepath: string): void {
    const fs = require('fs');
    const content = this.history.join('\n');
    fs.writeFileSync(filepath, content, 'utf-8');
  }
}

// Singleton instances
export const terminalHITL = new TerminalHITL();
export const eventFormatter = new EventFormatter();
