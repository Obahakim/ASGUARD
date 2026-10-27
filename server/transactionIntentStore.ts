import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { TransactionIntent, TransactionIntentStatus, TransactionPreflight } from './types';

const intents = new Map<string, TransactionIntent>();
const intentFile = process.env.ASGUARD_TRANSACTION_INTENTS_PATH || path.join(os.homedir(), '.asguard', 'transaction_intents.json');

function persistLocalIntents(): void {
  const directory = path.dirname(intentFile);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${intentFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify([...intents.values()], null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, intentFile);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
}

function loadLocalIntents(): void {
  if (!fs.existsSync(intentFile)) return;
  const parsed: unknown = JSON.parse(fs.readFileSync(intentFile, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('Transaction intent store is malformed; refusing to start with an empty idempotency ledger.');
  for (const value of parsed) {
    if (!value || typeof value !== 'object' || typeof (value as TransactionIntent).id !== 'string' ||
      typeof (value as TransactionIntent).idempotency_key !== 'string' ||
      !Object.prototype.hasOwnProperty.call(transitions, (value as TransactionIntent).status)) {
      throw new Error('Transaction intent store contains an invalid record; refusing to start.');
    }
    const intent = value as TransactionIntent;
    const duplicateKey = [...intents.values()].some((existing) => existing.idempotency_key === intent.idempotency_key);
    if (duplicateKey || intents.has(intent.id)) throw new Error('Transaction intent store contains duplicate identities.');
    intents.set(intent.id, intent);
  }
}

const transitions: Record<TransactionIntentStatus, TransactionIntentStatus[]> = {
  created: ['evaluating', 'expired'],
  evaluating: ['blocked', 'awaiting_approval', 'approved', 'pending_hitl', 'rejected', 'failed', 'expired'],
  pending_hitl: ['approved', 'rejected', 'expired'],
  blocked: [],
  awaiting_approval: ['approved', 'rejected', 'expired'],
  approved: ['authorized', 'rejected', 'expired'],
  authorized: ['submitted', 'failed'],
  submitted: ['confirmed', 'failed'],
  confirmed: [],
  rejected: [],
  expired: [],
  failed: [],
};

loadLocalIntents();

function now(): string {
  return new Date().toISOString();
}

export function createTransactionIntent(
  input: Omit<TransactionIntent, 'id' | 'status' | 'created_at' | 'updated_at'>
): TransactionIntent {
  const existing = [...intents.values()].find((intent) => intent.idempotency_key === input.idempotency_key);
  if (existing) return existing;

  const timestamp = now();
  const intent: TransactionIntent = {
    ...input,
    id: `intent_${crypto.randomUUID()}`,
    status: 'created',
    created_at: timestamp,
    updated_at: timestamp,
  };
  intents.set(intent.id, intent);
  try {
    persistLocalIntents();
  } catch (error) {
    intents.delete(intent.id);
    throw error;
  }
  return intent;
}

export function transitionTransactionIntent(id: string, status: TransactionIntentStatus): TransactionIntent {
  const intent = intents.get(id);
  if (!intent) throw new Error('transaction intent not found');
  if (!transitions[intent.status].includes(status)) throw new Error(`invalid transition: ${intent.status} -> ${status}`);
  const updated = { ...intent, status, updated_at: now() };
  intents.set(id, updated);
  try {
    persistLocalIntents();
  } catch (error) {
    intents.set(id, intent);
    throw error;
  }
  return updated;
}

export function recordPreflight(id: string, preflight: TransactionPreflight): TransactionIntent {
  const intent = intents.get(id);
  if (!intent) throw new Error('transaction intent not found');
  if (intent.status !== 'evaluating') throw new Error('intent must be evaluating before preflight is recorded');
  const updated = {
    ...intent,
    preflight: structuredClone(preflight),
    updated_at: now(),
  };
  intents.set(id, updated);
  try {
    persistLocalIntents();
  } catch (error) {
    intents.set(id, intent);
    throw error;
  }
  return updated;
}

export function getTransactionIntent(id: string): TransactionIntent | undefined {
  return intents.get(id);
}

export function listTransactionIntents(): TransactionIntent[] {
  return [...intents.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
}
