/**
 * Asguard Policy Store
 * Manages read/write of policy configuration from ~/.astrid/asguard_policy.json
 */

import fs from 'fs';
import path from 'path';
import { AsguardPolicy } from './types';

export class PolicyStore {
  private policyPath: string;
  private policy: AsguardPolicy;
  private watchers: ((policy: AsguardPolicy) => void)[] = [];

  constructor() {
    // Resolve to ~/.astrid/asguard_policy.json
    const homeDir = process.env.HOME || process.env.USERPROFILE || '/root';
    const astridDir = path.join(homeDir, '.astrid');
    this.policyPath = path.join(astridDir, 'asguard_policy.json');

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

      const toWrite: AsguardPolicy = {
        ...this.policy,
        updated_at: new Date().toISOString(),
      };

      fs.writeFileSync(
        this.policyPath,
        JSON.stringify(toWrite, null, 2),
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
    }

    // Update policy
    this.policy[field] = value as never;
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
    this.policy = this.getDefaultPolicy();
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
