export interface AuditRecord {
  id: string;
  timestamp: string;
  eventType: string;
  payload: Record<string, unknown>;
  localOnly: boolean;
  anchored: boolean;
}

export class AuditAnchor {
  private records: AuditRecord[] = [];

  record(eventType: string, payload: Record<string, unknown>, localOnly = true): AuditRecord {
    const record: AuditRecord = {
      id: `audit_${Date.now()}`,
      timestamp: new Date().toISOString(),
      eventType,
      payload,
      localOnly,
      anchored: false,
    };

    this.records.push(record);
    return record;
  }

  exportLocal(): AuditRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  anchor(record: AuditRecord): AuditRecord {
    return {
      ...record,
      anchored: true,
      localOnly: false,
    };
  }
}

export const auditAnchor = new AuditAnchor();
