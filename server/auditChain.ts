import { AuditChainEntry } from './types';
import { logger } from './logger';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getAuditSigningKey } from './auditConfig';

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
    this.signingKey = getAuditSigningKey();
    this.chainFile = chainFilePath || process.env.ASGUARD_AUDIT_CHAIN_PATH || path.join(os.homedir(), '.asguard', 'audit_chain.json');
    this.loadChain();
    if (!this.verifyChainIntegrity()) {
      throw new Error('Audit chain integrity check failed during startup.');
    }
  }

  /**
   * Load chain from persistent storage
   */
  private loadChain(): void {
    if (!fs.existsSync(this.chainFile)) {
      return;
    }

    const data = fs.readFileSync(this.chainFile, 'utf-8');
    const parsed = JSON.parse(data) as { entries?: unknown; sequence?: unknown };
    if (!Array.isArray(parsed.entries) || !Number.isInteger(parsed.sequence)) {
      throw new Error('Audit chain file has an invalid format.');
    }

    this.chain = parsed.entries as AuditChainEntry[];
    this.sequenceNumber = parsed.sequence as number;
    logger.info(`[AuditChain] Loaded ${this.chain.length} entries from chain`);
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
    const entryData = this.entryData(entry);

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
    try {
      this.persistChain();
    } catch (error) {
      this.chain.pop();
      this.sequenceNumber -= 1;
      throw error;
    }

    logger.debug(`[AuditChain] Added entry ${entry.sequence_number}: ${action}`, {
      agent: agentId,
      score: anomalyScore,
    } as Record<string, unknown>);

    return entry;
  }

  addAuditEvent(eventType: string, payload: Record<string, unknown>): AuditChainEntry {
    const safePayload = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    const eventId = typeof safePayload.id === 'string' ? safePayload.id : crypto.randomUUID();
    const agentId = typeof safePayload.agent_id === 'string' ? safePayload.agent_id : 'system';
    const entry = this.createEntry({
      eventId,
      agentId,
      action: eventType,
      eventType,
      payload: safePayload,
    });
    return entry;
  }

  private createEntry(input: {
    eventId: string;
    agentId: string;
    action: string;
    anomalyScore?: number;
    eventType?: string;
    payload?: Record<string, unknown>;
  }): AuditChainEntry {
    const previousHash = this.chain.length > 0 ? this.chain[this.chain.length - 1].entry_hash : 'genesis';
    const entry: AuditChainEntry = {
      sequence_number: this.sequenceNumber++,
      timestamp: new Date().toISOString(),
      event_id: input.eventId,
      agent_id: input.agentId,
      action: input.action,
      anomaly_score: input.anomalyScore,
      event_type: input.eventType,
      payload: input.payload,
      previous_hash: previousHash,
      entry_hash: '',
      signature: '',
    };
    entry.entry_hash = crypto.createHash('sha256').update(this.entryData(entry)).digest('hex');
    entry.signature = crypto.createHmac('sha256', this.signingKey).update(`${entry.entry_hash}${entry.previous_hash}`).digest('hex');
    this.chain.push(entry);
    try {
      this.persistChain();
    } catch (error) {
      this.chain.pop();
      this.sequenceNumber -= 1;
      throw error;
    }
    return entry;
  }

  private entryData(entry: AuditChainEntry): string {
    return JSON.stringify({
      sequence: entry.sequence_number,
      timestamp: entry.timestamp,
      event_id: entry.event_id,
      agent_id: entry.agent_id,
      action: entry.action,
      anomaly_score: entry.anomaly_score,
      previous_hash: entry.previous_hash,
      event_type: entry.event_type,
      payload: entry.payload,
    });
  }

  /**
   * Verify chain integrity (tamper detection)
   */
  verifyChainIntegrity(): boolean {
    let previousHash = 'genesis';

    for (const [index, entry] of this.chain.entries()) {
      if (entry.sequence_number !== index) {
        logger.error(`[AuditChain] Unexpected sequence number at index ${index}`);
        return false;
      }

      // Check previous hash link
      if (entry.previous_hash !== previousHash) {
        logger.error(`[AuditChain] Chain broken at sequence ${entry.sequence_number}`);
        return false;
      }

      // Verify HMAC signature
      const entryData = this.entryData(entry);

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

    return this.sequenceNumber === this.chain.length;
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
      entries: structuredClone(this.chain),
      integrity_verified: this.verifyChainIntegrity(),
    };
  }

  /**
   * Persist chain to disk
   */
  private persistChain(): void {
    const chainDir = path.dirname(this.chainFile);
    if (!fs.existsSync(chainDir)) {
      fs.mkdirSync(chainDir, { recursive: true, mode: 0o700 });
    }

    const temporaryPath = `${this.chainFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(
        temporaryPath,
        JSON.stringify({
          entries: this.chain,
          sequence: this.sequenceNumber,
          last_updated: new Date().toISOString(),
        }, null, 2),
        { encoding: 'utf-8', mode: 0o600 }
      );
      fs.renameSync(temporaryPath, this.chainFile);
    } catch (error) {
      if (fs.existsSync(temporaryPath)) {
        fs.unlinkSync(temporaryPath);
      }
      logger.error('[AuditChain] Failed to persist chain:', { error: String(error) });
      throw error;
    }
  }

}

let sharedAuditChain: AuditChain | undefined;

export function getSharedAuditChain(): AuditChain {
  sharedAuditChain ??= new AuditChain();
  return sharedAuditChain;
}
