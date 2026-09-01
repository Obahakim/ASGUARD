import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import type { TransactionIntent } from './types';

const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
const db = pool ? drizzle(pool) : null;

export function neonPersistenceEnabled() { return Boolean(db); }

export async function persistIntent(intent: TransactionIntent) {
  if (!db) return;
  await db.execute(sql`INSERT INTO asguard_transaction_intents
    (id, subject, chain_id, network, wallet_address, target_address, value, calldata, function_selector, status, risk_score, policy_version, simulation, created_at, updated_at)
    VALUES (${intent.id}, ${intent.wallet_id}, ${intent.network}, ${intent.network}, ${intent.wallet_id}, ${intent.resource}, ${intent.amount ?? '0'}, ${intent.payload_hash}, ${null}, ${intent.status}, ${intent.risk_level === 'critical' ? 100 : intent.risk_level === 'high' ? 75 : intent.risk_level === 'medium' ? 40 : 10}, ${intent.policy_version ?? 'unknown'}, ${null}, ${intent.created_at}, ${intent.updated_at})
    ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`);
}

export async function loadIntents(): Promise<TransactionIntent[]> {
  if (!db) return [];
  const result = await db.execute(sql`SELECT id, subject, network, status, policy_version, created_at, updated_at FROM asguard_transaction_intents ORDER BY created_at DESC`);
  return (result.rows as Record<string, unknown>[]).map((row) => ({
    id: String(row.id), idempotency_key: String(row.id), correlation_id: String(row.id), agent_id: 'persisted', wallet_id: String(row.subject), network: String(row.network), action: 'transaction', resource: String(row.subject), payload_hash: '', status: row.status as TransactionIntent['status'], risk_level: 'medium', policy_version: row.policy_version ? String(row.policy_version) : undefined, expires_at: String(row.updated_at), created_at: String(row.created_at), updated_at: String(row.updated_at),
  }));
}
