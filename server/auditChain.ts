import { AuditChainEntry } from './types';
import { logger } from './logger';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * AuditChain maintains cryptographically signed, chain-linked audit logs
 * Ensures immutability and tamper-detection
 */
export class AuditChain {
  private chain: AuditChainEntry[] = [];
  private chainFile: string;
  private signingKey: string;
  private sequenceNumber: number = 0;

  constructor(chainFilePath?: string) {
    this.chainFile = chainFilePath || path.join(
      process.env.HOME || '/tmp',
      '.astrid/audit_chain.json'
    );
    this.signingKey = process.env.ASGUARD_AUDIT_KEY || 'default_audit_key_change_in_production';
    this.loadChain();
  }

  /**
   * Load chain from persistent storage
   */
  private loadChain(): void {
    try {
      if (fs.existsSync(this.chainFile)) {
        const data = fs.readFileSync(this.chainFile, 'utf-8');
        const parsed = JSON.parse(data);
        this.chain = parsed.entries || [];
        this.sequenceNumber = parsed.sequence || 0;
        logger.info(`[AuditChain] Loaded ${this.chain.length} entries from chain`);
      }
    } catch (error) {
      logger.warn(`[AuditChain] Failed to load chain:`, { error: String(error) } as Record<string, unknown>);
      this.chain = [];
    }
  }

  /**
   * Add entry to chain with HMAC signature
   */
  addEntry(
    eventId: string,
    agentId: string,
    action: string,
    anomalyScore?: number
  ): AuditChainEntry {
    const previousHash = this.chain.length > 0
      ? this.chain[this.chain.length - 1].entry_hash
      : 'genesis';

    const entry: AuditChainEntry = {
      sequence_number: this.sequenceNumber++,
      timestamp: new Date().toISOString(),
      event_id: eventId,
      agent_id: agentId,
      action,
      anomaly_score: anomalyScore,
      previous_hash: previousHash,
      entry_hash: '',
      signature: '',
    };

    // Calculate entry hash
    const entryData = JSON.stringify({
      sequence: entry.sequence_number,
      timestamp: entry.timestamp,
      event_id: entry.event_id,
      agent_id: entry.agent_id,
      action: entry.action,
      anomaly_score: entry.anomaly_score,
      previous_hash: entry.previous_hash,
    });

    entry.entry_hash = crypto
      .createHash('sha256')
      .update(entryData)
      .digest('hex');

    // Sign with HMAC
    entry.signature = crypto
      .createHmac('sha256', this.signingKey)
      .update(`${entry.entry_hash}${entry.previous_hash}`)
      .digest('hex');

    this.chain.push(entry);
    this.persistChain();

    logger.debug(`[AuditChain] Added entry ${entry.sequence_number}: ${action}`, {
      agent: agentId,
      score: anomalyScore,
    } as Record<string, unknown>);

    return entry;
  }

  /**
   * Verify chain integrity (tamper detection)
   */
  verifyChainIntegrity(): boolean {
    let previousHash = 'genesis';

    for (const entry of this.chain) {
      // Check previous hash link
      if (entry.previous_hash !== previousHash) {
        logger.error(`[AuditChain] Chain broken at sequence ${entry.sequence_number}`);
        return false;
      }

      // Verify HMAC signature
      const entryData = JSON.stringify({
        sequence: entry.sequence_number,
        timestamp: entry.timestamp,
        event_id: entry.event_id,
        agent_id: entry.agent_id,
        action: entry.action,
        anomaly_score: entry.anomaly_score,
        previous_hash: entry.previous_hash,
      });

      const expectedHash = crypto
        .createHash('sha256')
        .update(entryData)
        .digest('hex');

      if (entry.entry_hash !== expectedHash) {
        logger.error(`[AuditChain] Entry hash mismatch at sequence ${entry.sequence_number}`);
        return false;
      }

      const expectedSignature = crypto
        .createHmac('sha256', this.signingKey)
        .update(`${entry.entry_hash}${entry.previous_hash}`)
        .digest('hex');

      if (entry.signature !== expectedSignature) {
        logger.error(`[AuditChain] Signature verification failed at sequence ${entry.sequence_number}`);
        return false;
      }

      previousHash = entry.entry_hash;
    }

    return true;
  }

  /**
   * Get entries for an agent
   */
  getEntriesForAgent(agentId: string): AuditChainEntry[] {
    return this.chain.filter(e => e.agent_id === agentId);
  }

  /**
   * Get entries in time range
   */
  getEntriesByTimeRange(startTime: Date, endTime: Date): AuditChainEntry[] {
    const startMs = startTime.getTime();
    const endMs = endTime.getTime();
    return this.chain.filter(e => {
      const entryMs = new Date(e.timestamp).getTime();
      return entryMs >= startMs && entryMs <= endMs;
    });
  }

  /**
   * Get recent entries
   */
  getRecentEntries(limit: number = 100): AuditChainEntry[] {
    return this.chain.slice(-limit);
  }

  /**
   * Get chain statistics
   */
  getStats() {
    return {
      total_entries: this.chain.length,
      chain_valid: this.verifyChainIntegrity(),
      last_entry: this.chain.length > 0 ? this.chain[this.chain.length - 1].timestamp : null,
      sequence_number: this.sequenceNumber,
    };
  }

  /**
   * Export chain for auditing
   */
  exportChain(): { entries: AuditChainEntry[]; integrity_verified: boolean } {
    return {
      entries: this.chain,
      integrity_verified: this.verifyChainIntegrity(),
    };
  }

  /**
   * Persist chain to disk
   */
  private persistChain(): void {
    try {
      const chainDir = path.dirname(this.chainFile);
      if (!fs.existsSync(chainDir)) {
        fs.mkdirSync(chainDir, { recursive: true });
      }

      fs.writeFileSync(
        this.chainFile,
        JSON.stringify({
          entries: this.chain,
          sequence: this.sequenceNumber,
          last_updated: new Date().toISOString(),
        }, null, 2),
        'utf-8'
      );
    } catch (error) {
      logger.error(`[AuditChain] Failed to persist chain:`, { error: String(error) } as Record<string, unknown>);
    }
  }

  /**
   * Clear chain (for testing only)
   */
  clearChain(): void {
    this.chain = [];
    this.sequenceNumber = 0;
    logger.warn('[AuditChain] Chain cleared');
  }
}

export default new AuditChain();
