import crypto from 'node:crypto';
import type { ApprovalDecisionAction, NotifierAlert } from './types';

export type NotificationSeverity = 'LOW' | 'ELEVATED' | 'HIGH' | 'CRITICAL';

export function computeSeverity(score: number): NotificationSeverity {
  if (score >= 90) return 'CRITICAL';
  if (score >= 70) return 'HIGH';
  if (score >= 40) return 'ELEVATED';
  return 'LOW';
}

export function buildAlertBadge(score: number): string {
  const severity = computeSeverity(score);
  const symbols: Record<NotificationSeverity, string> = {
    LOW: '🟢',
    ELEVATED: '🟡',
    HIGH: '🔴',
    CRITICAL: '⛔',
  };
  return `${symbols[severity]} ${severity} (${score})`;
}

export class Notifier {
  private dedupeWindowMs = 15 * 60 * 1000;
  private sentMap = new Map<string, number>();

  private getConfiguredWebhooks(): string[] {
    const urls = [
      process.env.TELEGRAM_WEBHOOK_URL,
      process.env.SLACK_WEBHOOK_URL,
      process.env.DISCORD_WEBHOOK_URL,
      process.env.ASGUARD_GENERIC_WEBHOOK_URL,
    ].filter((value): value is string => Boolean(value && value.trim()));
    return [...new Set(urls)];
  }

  private dedupeKey(alert: Pick<NotifierAlert, 'agent_id' | 'request_id' | 'action'>): string {
    return `${alert.agent_id}:${alert.request_id}:${alert.action}`;
  }

  private shouldSend(alert: Pick<NotifierAlert, 'agent_id' | 'request_id' | 'action'>): boolean {
    const key = this.dedupeKey(alert);
    const now = Date.now();
    const last = this.sentMap.get(key);
    if (last && now - last < this.dedupeWindowMs) return false;
    this.sentMap.set(key, now);
    return true;
  }

  async send(alert: NotifierAlert): Promise<{ sent: boolean; channelCount: number }> {
    const severity = computeSeverity(alert.score);
    if ((alert.score < 70 && !alert.requires_hitl) || alert.status !== 'pending_hitl') {
      return { sent: false, channelCount: 0 };
    }

    const channels = this.getConfiguredWebhooks();
    if (channels.length === 0) return { sent: false, channelCount: 0 };
    if (!this.shouldSend(alert)) {
      return { sent: false, channelCount: 0 };
    }

    const payload = {
      text: [
        `${buildAlertBadge(alert.score)}`,
        `agent_id: ${alert.agent_id}`,
        `action: ${alert.action}`,
        alert.amount_usd !== undefined ? `amount_usd: ${alert.amount_usd}` : undefined,
        `status: ${alert.status}`,
        `expires_at: ${alert.expires_at}`,
        `request_id: ${alert.request_id}`,
        `top_rules: ${(alert.top_rules ?? alert.rules.slice(0, 3).map(rule => rule.rule_id)).join(', ') || 'none'}`,
        '',
        ...alert.rules.slice(0, 3).map((rule) => `rule: ${rule.rule_id} (${rule.score_contribution})`),
      ].filter(Boolean).join('\n'),
      embeds: [
        {
          title: `ASGUARD ${severity} alert`,
          description: `Agent ${alert.agent_id} requires action for ${alert.action}.`,
          color: severity === 'CRITICAL' ? 16711680 : severity === 'HIGH' ? 16729871 : 16776960,
          fields: [
            { name: 'Request ID', value: alert.request_id },
            { name: 'Score', value: String(alert.score) },
            { name: 'Status', value: alert.status },
            { name: 'Expires', value: alert.expires_at },
            ...(alert.amount_usd !== undefined ? [{ name: 'Amount USD', value: String(alert.amount_usd) }] : []),
          ],
        },
      ],
    };

    let channelCount = 0;
    for (const url of channels) {
      try {
        if (!url.startsWith('http')) continue;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (response.ok) channelCount += 1;
      } catch {
        // swallow webhook errors and fail closed by continuing to other channels
      }
    }
    return { sent: channelCount > 0, channelCount };
  }

  async notifyForDecision(payload: {
    agent_id: string;
    action: string;
    amount_usd?: number;
    request_id: string;
    status: string;
    expires_at: string;
    score: number;
    rules: Array<{ rule_id: string; score_contribution: number; details?: Record<string, unknown> }>;
    requires_hitl?: boolean;
  }): Promise<{ sent: boolean; channelCount: number }> {
    return this.send({
      agent_id: payload.agent_id,
      score: payload.score,
      action: payload.action,
      amount_usd: payload.amount_usd,
      request_id: payload.request_id,
      status: payload.status,
      expires_at: payload.expires_at,
      rules: payload.rules,
      badge: buildAlertBadge(payload.score),
      requires_hitl: payload.requires_hitl,
    });
  }

  buildDecisionActions(score: number): ApprovalDecisionAction[] {
    if (score >= 70) return ['deny_terminate'];
    return ['approve_once', 'deny_terminate'];
  }

  async sendDigest(message: string): Promise<boolean> {
    const urls = this.getConfiguredWebhooks();
    for (const url of urls) {
      try {
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: message }),
        });
      } catch {
        // ignore
      }
    }
    return urls.length > 0;
  }

  static severityFor(score: number): NotificationSeverity {
    return computeSeverity(score);
  }
}

export const notifier = new Notifier();
export default notifier;
