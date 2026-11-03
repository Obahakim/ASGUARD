import type { TransactionIntent } from '../types';
import { normalizeNearTransfer } from '../aos/nearTransfer';

export interface SubmissionReportInput {
  intent_id: string;
  payload_hash: string;
  tx_hash: string;
}

export function validateSubmissionReport(input: unknown, intent: TransactionIntent | undefined): SubmissionReportInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A submission report object is required.');
  const report = input as Partial<SubmissionReportInput>;
  if (typeof report.intent_id !== 'string' || !report.intent_id.trim()
    || typeof report.payload_hash !== 'string' || !/^[\da-f]{64}$/i.test(report.payload_hash)
    || typeof report.tx_hash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(report.tx_hash)) {
    throw new Error('intent_id, a SHA-256 payload_hash, and a valid NEAR transaction hash are required.');
  }
  if (!intent || intent.id !== report.intent_id) throw new Error('Approved transaction intent not found.');
  if (intent.network !== 'near:testnet') throw new Error('Submission reporting is enabled for NEAR testnet only.');
  if (intent.payload_domain !== 'near-transfer' || !intent.transfer) throw new Error('Only approved NEAR transfer intents can be reported.');
  if (intent.payload_hash !== report.payload_hash) throw new Error('payload_hash does not match the approved intent.');
  if (intent.status !== 'approved' && !(intent.status === 'submitted' && intent.tx_hash === report.tx_hash)) {
    throw new Error('Transaction intent must be approved before submission reporting.');
  }
  return { intent_id: report.intent_id, payload_hash: report.payload_hash, tx_hash: report.tx_hash };
}

export function verifyFinalizedNearTransfer(
  report: SubmissionReportInput,
  intent: TransactionIntent,
  transaction: unknown,
  watchedAccounts: string[],
): void {
  const record = transaction && typeof transaction === 'object' && !Array.isArray(transaction)
    ? transaction as Record<string, unknown> : undefined;
  const tx = record?.transaction && typeof record.transaction === 'object'
    ? record.transaction as Record<string, unknown> : undefined;
  const status = record?.status && typeof record.status === 'object'
    ? record.status as Record<string, unknown> : undefined;
  if (record?.final_execution_status !== 'FINAL') throw new Error('NEAR transaction is not finalized.');
  if (typeof tx?.hash !== 'string' || tx.hash !== report.tx_hash) throw new Error('NEAR RPC transaction hash does not match the report.');
  if (typeof tx.signer_id !== 'string' || !watchedAccounts.includes(tx.signer_id) || tx.signer_id !== intent.transfer?.sender) {
    throw new Error('NEAR transaction signer is not the approved transfer sender in the agent watch list.');
  }
  if (tx.receiver_id !== intent.transfer?.receiver) throw new Error('NEAR transaction receiver does not match the approved transfer.');
  const actions = Array.isArray(tx.actions) ? tx.actions : [];
  const action = actions.length === 1 && actions[0] && typeof actions[0] === 'object'
    ? actions[0] as Record<string, unknown> : undefined;
  const transfer = action?.Transfer && typeof action.Transfer === 'object'
    ? action.Transfer as Record<string, unknown> : undefined;
  if (actions.length !== 1 || typeof transfer?.deposit !== 'string' || transfer.deposit !== intent.transfer?.amount) {
    throw new Error('NEAR transaction amount or action does not match the approved transfer.');
  }
  if (!status || (!Object.prototype.hasOwnProperty.call(status, 'SuccessValue')
    && !Object.prototype.hasOwnProperty.call(status, 'SuccessReceiptId'))) {
    throw new Error('NEAR transaction did not finalize successfully.');
  }
  const canonical = normalizeNearTransfer(intent.transfer);
  if (canonical.payloadHash !== report.payload_hash) throw new Error('Stored transfer terms do not match the approved payload hash.');
}