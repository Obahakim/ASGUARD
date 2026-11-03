import type { TransactionIntent } from '../types';

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
  if (intent.payload_hash !== report.payload_hash) throw new Error('payload_hash does not match the approved intent.');
  if (intent.status !== 'approved' && !(intent.status === 'submitted' && intent.tx_hash === report.tx_hash)) {
    throw new Error('Transaction intent must be approved before submission reporting.');
  }
  return { intent_id: report.intent_id, payload_hash: report.payload_hash, tx_hash: report.tx_hash };
}