/**
 * Asguard Logger
 * Handles terminal logging with ANSI colors and WebSocket event broadcasting
 */

import { Event, EventType } from './types';
import { WebSocketBridge } from './bridge';

type LogLevel = 'info' | 'warn' | 'error' | 'success' | 'debug';

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

export class Logger {
  private logEntries: LogEntry[] = [];
  private maxHistorySize = 1000;
  private bridge: WebSocketBridge | null = null;

  private colorMap: Record<LogLevel, string> = {
    info: '\x1b[36m', // Cyan
    warn: '\x1b[33m', // Yellow
    error: '\x1b[31m', // Red
    success: '\x1b[32m', // Green
    debug: '\x1b[35m', // Magenta
  };

  private resetColor = '\x1b[0m';

  /**
   * Set WebSocket bridge for event broadcasting
   */
  public setBridge(bridge: WebSocketBridge): void {
    this.bridge = bridge;
  }

  /**
   * Format terminal output with color
   */
  private formatTerminal(
    level: LogLevel,
    message: string,
    timestamp: string
  ): string {
    const color = this.colorMap[level];
    const levelStr = level.toUpperCase().padEnd(7);
    return `${color}[${timestamp}] [${levelStr}]${this.resetColor} ${message}`;
  }

  /**
   * Core logging function
   */
  private log(
    level: LogLevel,
    message: string,
    data?: Record<string, unknown>
  ): void {
    const timestamp = new Date().toISOString();
    const entry: LogEntry = {
      level,
      message,
      timestamp,
      data,
    };

    // Store in history
    this.logEntries.push(entry);
    if (this.logEntries.length > this.maxHistorySize) {
      this.logEntries.shift();
    }

    // Terminal output
    const formatted = this.formatTerminal(level, message, timestamp);
    if (data) {
      console.log(formatted, data);
    } else {
      console.log(formatted);
    }
  }

  /**
   * Log info message
   */
  public info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }

  /**
   * Log warning message
   */
  public warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }

  /**
   * Log error message
   */
  public error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data);
  }

  /**
   * Log success message
   */
  public success(message: string, data?: Record<string, unknown>): void {
    this.log('success', message, data);
  }

  /**
   * Log debug message
   */
  public debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }

  /**
   * Broadcast event to WebSocket clients and log to terminal
   */
  public broadcastEvent(event: Event): void {
    // Log event to terminal
    this.logEvent(event);

    // Broadcast to WebSocket clients if bridge is available
    if (this.bridge) {
      this.bridge.broadcastEvent(event);
    }
  }

  /**
   * Format and log event details
   */
  private logEvent(event: Event): void {
    const timestamp = event.timestamp;
    const typeStr = `[${event.type.toUpperCase()}]`.padEnd(25);

    switch (event.type) {
      case 'agent_activity':
        this.info(
          `${typeStr} Agent: ${event.agent_name} | Action: ${event.action} | Risk: ${event.risk_level}`,
          event.details
        );
        break;

      case 'anomaly_detected':
        this.warn(
          `${typeStr} Agent: ${event.agent_id} | Type: ${event.anomaly_type} | Confidence: ${event.confidence_score}`,
          event.details
        );
        break;

      case 'security_violation':
        this.error(
          `${typeStr} Agent: ${event.agent_id} | Violation: ${event.violation_type} | Severity: ${event.severity}`,
          event.context
        );
        break;

      case 'capability_check':
        const statusStr = event.status === 'allowed' ? '✓' : '✗';
        this.info(`${typeStr} ${statusStr} ${event.capability} for ${event.agent_id}`);
        break;

      case 'hitl_request':
        this.warn(
          `${typeStr} Request: ${event.request_id} | Agent: ${event.agent_id} | Type: ${event.incident_type}`,
          { action_options: event.action_options, expires_at: event.expires_at }
        );
        break;

      case 'audit_log': {
        const auditEvent = event as Extract<Event, { type: 'audit_log' }>;
        this.info(
          `${typeStr} [${auditEvent.status}] ${auditEvent.action} on ${auditEvent.resource}`,
          typeof auditEvent.details === 'object' && auditEvent.details !== null 
            ? (auditEvent.details as Record<string, unknown>) 
            : { details: auditEvent.details }
        );
        break;
      }

      case 'policy_update':
        this.success(
          `${typeStr} Updated ${event.field}: ${JSON.stringify(event.old_value)} → ${JSON.stringify(event.new_value)}`
        );
        break;

      case 'connection_status':
        if (event.status === 'connected') {
          this.success(`${typeStr} Connected to ${event.daemon}`);
        } else {
          this.error(`${typeStr} Disconnected from ${event.daemon}`);
        }
        break;

      default: {
        const unknownEvent = event as any;
        this.info(`${typeStr} [ID: ${unknownEvent.id}]`);
      }
    }
  }

  /**
   * Get log history
   */
  public getHistory(limit: number = 100): LogEntry[] {
    return this.logEntries.slice(-limit);
  }

  /**
   * Clear log history
   */
  public clearHistory(): void {
    this.logEntries = [];
    this.info('Log history cleared');
  }

  /**
   * Export logs as JSON
   */
  public exportLogs(): string {
    return JSON.stringify(this.logEntries, null, 2);
  }
}

// Export singleton instance
export const logger = new Logger();
