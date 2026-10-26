import type { AuditChainEntry } from '../types';
import { getSharedAuditChain, type AuditChain } from '../auditChain';

export class AuditAnchor {
  constructor(private readonly chain?: AuditChain) {}

  record(eventType: string, payload: Record<string, unknown>): AuditChainEntry {
    return this.getChain().addAuditEvent(eventType, payload);
  }

  export(): { entries: AuditChainEntry[]; integrity_verified: boolean } {
    return this.getChain().exportChain();
  }

  private getChain(): AuditChain {
    return this.chain ?? getSharedAuditChain();
  }
}

export const auditAnchor = new AuditAnchor();