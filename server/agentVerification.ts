import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveStatePath } from './stateDir';

export const agentVerificationStatuses = ['unverified', 'verified', 'decoy'] as const;
export type AgentVerificationStatus = typeof agentVerificationStatuses[number];

export interface AgentVerificationRecord {
  agent_id: string;
  status: AgentVerificationStatus;
  updated_at: string;
  updated_by: string;
}

function isStatus(value: unknown): value is AgentVerificationStatus {
  return typeof value === 'string' && agentVerificationStatuses.includes(value as AgentVerificationStatus);
}

function isValidAgentId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isValidIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isRecord(value: unknown): value is AgentVerificationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<AgentVerificationRecord>;
  return isValidAgentId(record.agent_id)
    && isStatus(record.status)
    && typeof record.updated_at === 'string' && Number.isFinite(Date.parse(record.updated_at))
    && isValidIdentity(record.updated_by);
}

export class AgentVerificationStore {
  private readonly records = new Map<string, AgentVerificationRecord>();
  private readonly filePath: string;

  constructor(filePath = resolveStatePath('agent_verifications.json', 'ASGUARD_AGENT_VERIFICATIONS_PATH')) {
    this.filePath = filePath;
    if (!fs.existsSync(filePath)) return;
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(parsed) || !parsed.every(isRecord)) {
      throw new Error('Agent verification store is malformed.');
    }
    for (const record of parsed) {
      if (this.records.has(record.agent_id)) throw new Error('Agent verification store contains duplicate agent IDs.');
      this.records.set(record.agent_id, record);
    }
  }

  get(agentId: string): AgentVerificationRecord | { agent_id: string; status: 'unverified' } {
    return this.records.get(agentId) ?? { agent_id: agentId, status: 'unverified' };
  }

  getIntelligenceContext(agentId: string): { status: AgentVerificationStatus; updated_at?: string } {
    const record = this.get(agentId);
    return { status: record.status, ...('updated_at' in record ? { updated_at: record.updated_at } : {}) };
  }

  list(): AgentVerificationRecord[] {
    return [...this.records.values()].sort((a, b) => a.agent_id.localeCompare(b.agent_id));
  }

  set(agentId: string, status: AgentVerificationStatus, updatedBy: string): AgentVerificationRecord {
    if (!isValidAgentId(agentId)) throw new Error('agent_id must be a non-empty string of at most 128 characters.');
    if (!isStatus(status)) throw new Error('status must be unverified, verified, or decoy.');
    if (!isValidIdentity(updatedBy)) throw new Error('updated_by must be a non-empty string of at most 128 characters.');

    const record: AgentVerificationRecord = {
      agent_id: agentId,
      status,
      updated_at: new Date().toISOString(),
      updated_by: updatedBy,
    };
    const previous = this.records.get(agentId);
    this.records.set(agentId, record);
    try {
      this.persist();
    } catch (error) {
      if (previous) this.records.set(agentId, previous);
      else this.records.delete(agentId);
      throw error;
    }
    return record;
  }

  private persist(): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(this.list(), null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
      throw error;
    }
  }
}

export const agentVerificationStore = new AgentVerificationStore();
