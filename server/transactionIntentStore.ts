import crypto from 'node:crypto';
import type { TransactionIntent, TransactionIntentStatus, TransactionSimulation } from './types';

const intents = new Map<string, TransactionIntent>();

const transitions: Record<TransactionIntentStatus, TransactionIntentStatus[]> = {
  created: ['evaluating', 'expired'],
  evaluating: ['blocked', 'awaiting_approval', 'approved', 'failed', 'expired'],
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

function now() { return new Date().toISOString(); }

export function createTransactionIntent(input: Omit<TransactionIntent, 'id' | 'status' | 'created_at' | 'updated_at'>) {
  if (intents.has(input.idempotency_key)) return [...intents.values()].find((intent) => intent.idempotency_key === input.idempotency_key)!;
  const timestamp = now();
  const intent: TransactionIntent = { ...input, id: `intent_${crypto.randomUUID()}`, status: 'created', created_at: timestamp, updated_at: timestamp };
  intents.set(intent.id, intent);
  return intent;
}

export function transitionTransactionIntent(id: string, status: TransactionIntentStatus) {
  const intent = intents.get(id);
  if (!intent) throw new Error('transaction intent not found');
  if (!transitions[intent.status].includes(status)) throw new Error(`invalid transition: ${intent.status} -> ${status}`);
  const updated = { ...intent, status, updated_at: now() };
  intents.set(id, updated);
  return updated;
}

export function recordSimulation(id: string, simulation: TransactionSimulation) {
  const intent = intents.get(id);
  if (!intent) throw new Error('transaction intent not found');
  if (intent.status !== 'evaluating') throw new Error('intent must be evaluating before simulation is recorded');
  return transitionTransactionIntent(id, simulation.status === 'passed' ? 'awaiting_approval' : 'blocked');
}

export function getTransactionIntent(id: string) { return intents.get(id); }
export function listTransactionIntents() { return [...intents.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)); }
