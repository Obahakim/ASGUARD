/**
 * Asguard Policy Store
 * Manages read/write of policy configuration from ~/.astrid/asguard_policy.json
 */

import fs from 'fs';
import path from 'path';
import { AsguardPolicy } from './types';

const MUTABLE_FIELDS = new Set<keyof AsguardPolicy>([
  'max_auto_trade_usd', 'strict_anomaly_detection', 'device_ip_lock', 'remote_trigger_protection',
  'active_llm_engine', 'allowed_intent_types', 'denied_intent_types', 'allowed_assets', 'denied_assets',
  'allowed_destinations', 'denied_destinations', 'allowed_intent_chains', 'denied_intent_chains',
  'max_slippage_bps', 'allowed_intent_hours_utc', 'intent_unknown_target_requires_hitl',
]);

function nextPolicyVersion(version: string | undefined): string {
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? `${match[1]}.${match[2]}.${Number(match[3]) + 1}` : `policy-${Date.now()}`;
}

export class PolicyStore {
  private policyPath: string;
  private policy: AsguardPolicy;
  private watchers: ((policy: AsguardPolicy) => void)[] = [];

  constructor(policyPath?: string) {
    // Resolve to ~/.astrid/asguard_policy.json
    const homeDir = process.env.HOME || process.env.USERPROFILE || '/root';
    const astridDir = path.join(homeDir, '.astrid');
    this.policyPath = policyPath ?? path.join(astridDir, 'asguard_policy.json');

    // Initialize with default policy
    this.policy = this.getDefaultPolicy();

    // Load existing policy if available
    try {
      this.load();
    } catch (error) {
      console.error('[PolicyStore] Failed to load policy, using defaults:', error);
      // Create directory and file with defaults
      this.ensureDirectory();
      this.save();
    }
  }

  /**
   * Get the default policy configuration
   */
  private getDefaultPolicy(): AsguardPolicy {
    return {
      max_auto_trade_usd: 10000,
      strict_anomaly_detection: true,
      device_ip_lock: true,
      remote_trigger_protection: true,
      active_llm_engine: 'ollama',
      allowed_intent_types: [],
      denied_intent_types: [],
      allowed_assets: [],
      denied_assets: [],
      allowed_destinations: [],
      denied_destinations: [],
      allowed_intent_chains: [],
      denied_intent_chains: [],
      max_slippage_bps: 1000,
      allowed_intent_hours_utc: [],
      intent_unknown_target_requires_hitl: true,
      updated_at: new Date().toISOString(),
      version: '1.0.0',
    };
  }

  /**
   * Ensure .astrid directory exists
   */
  private ensureDirectory(): void {
    const astridDir = path.dirname(this.policyPath);
    if (!fs.existsSync(astridDir)) {
      fs.mkdirSync(astridDir, { recursive: true });
      console.log(`[PolicyStore] Created directory: ${astridDir}`);
    }
  }

  /**
   * Load policy from disk
   */
  private load(): void {
    try {
      if (!fs.existsSync(this.policyPath)) {
        console.log(`[PolicyStore] Policy file not found at ${this.policyPath}, using defaults`);
        return;
      }

      const fileContent = fs.readFileSync(this.policyPath, 'utf-8');
      const loaded = JSON.parse(fileContent) as AsguardPolicy;

      // Validate and merge with defaults to handle missing fields
      this.policy = {
        ...this.getDefaultPolicy(),
        ...loaded,
        updated_at: loaded.updated_at || new Date().toISOString(),
        version: loaded.version || '1.0.0',
      };

      console.log(`[PolicyStore] Loaded policy from ${this.policyPath}`);
    } catch (error) {
      console.error(`[PolicyStore] Error loading policy:`, error);
      throw error;
    }
  }

  /**
   * Save policy to disk
   */
  private save(): void {
    try {
      this.ensureDirectory();
      this.policy.updated_at = new Date().toISOString();

      fs.writeFileSync(
        this.policyPath,
        JSON.stringify(this.policy, null, 2),
        'utf-8'
      );

      console.log(`[PolicyStore] Saved policy to ${this.policyPath}`);
      this.notifyWatchers();
    } catch (error) {
      console.error(`[PolicyStore] Error saving policy:`, error);
      throw error;
    }
  }

  /**
   * Get current policy
   */
  public getPolicy(): AsguardPolicy {
    return { ...this.policy };
  }

  /**
   * Update a single policy field
   */
  public updateField(
    field: keyof AsguardPolicy,
    value: unknown
  ): AsguardPolicy {
    if (!MUTABLE_FIELDS.has(field)) throw new Error(`Policy field is not mutable: ${String(field)}`);
    const oldValue = this.policy[field];

    // Validate field type
    if (field === 'max_auto_trade_usd') {
      if (typeof value !== 'number' || value < 0) {
        throw new Error('max_auto_trade_usd must be a positive number');
      }
    } else if (
      field === 'strict_anomaly_detection' ||
      field === 'device_ip_lock' ||
      field === 'remote_trigger_protection'
    ) {
      if (typeof value !== 'boolean') {
        throw new Error(`${field} must be a boolean`);
      }
    } else if (field === 'active_llm_engine') {
      if (!['ollama', 'claude', 'groq'].includes(value as string)) {
        throw new Error('active_llm_engine must be one of: ollama, claude, groq');
      }
    } else if ([
      'allowed_intent_types', 'denied_intent_types', 'allowed_assets', 'denied_assets',
      'allowed_destinations', 'denied_destinations', 'allowed_intent_chains', 'denied_intent_chains',
    ].includes(field)) {
      if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.trim() === item && item.length > 0)) {
        throw new Error(`${field} must be an array of non-empty strings.`);
      }
    } else if (field === 'max_slippage_bps') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10_000) {
        throw new Error('max_slippage_bps must be an integer from 0 to 10000.');
      }
    } else if (field === 'allowed_intent_hours_utc') {
      if (!Array.isArray(value) || !value.every(hour => Number.isInteger(hour) && hour >= 0 && hour <= 23)) {
        throw new Error('allowed_intent_hours_utc must contain UTC hours from 0 to 23.');
      }
    } else if (field === 'intent_unknown_target_requires_hitl') {
      if (typeof value !== 'boolean') throw new Error('intent_unknown_target_requires_hitl must be a boolean.');
    } else if (!Object.prototype.hasOwnProperty.call(this.policy, field)) {
      throw new Error(`Unknown policy field: ${String(field)}`);
    }

    // Update policy
    this.policy[field] = value as never;
    this.policy.version = nextPolicyVersion(this.policy.version);
    this.save();

    console.log(
      `[PolicyStore] Updated ${field}: ${JSON.stringify(oldValue)} -> ${JSON.stringify(value)}`
    );

    return { ...this.policy };
  }

  /**
   * Bulk update policy fields
   */
  public updatePolicy(updates: Partial<AsguardPolicy>): AsguardPolicy {
    for (const [field, value] of Object.entries(updates)) {
      this.updateField(field as keyof AsguardPolicy, value);
    }
    return { ...this.policy };
  }

  /**
   * Reset policy to defaults
   */
  public reset(): AsguardPolicy {
    const version = nextPolicyVersion(this.policy.version);
    this.policy = this.getDefaultPolicy();
    this.policy.version = version;
    this.save();
    console.log('[PolicyStore] Policy reset to defaults');
    return { ...this.policy };
  }

  /**
   * Subscribe to policy changes
   */
  public subscribe(callback: (policy: AsguardPolicy) => void): () => void {
    this.watchers.push(callback);

    // Return unsubscribe function
    return () => {
      this.watchers = this.watchers.filter((w) => w !== callback);
    };
  }

  /**
   * Notify all watchers of changes
   */
  private notifyWatchers(): void {
    this.watchers.forEach((callback) => {
      try {
        callback({ ...this.policy });
      } catch (error) {
        console.error('[PolicyStore] Error in watcher callback:', error);
      }
    });
  }

  /**
   * Get the policy file path
   */
  public getPolicyPath(): string {
    return this.policyPath;
  }
}

// Export singleton instance
export const policyStore = new PolicyStore();
