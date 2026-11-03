import { createHash } from 'node:crypto';
import type { AsguardPolicy } from '../types';

export interface NearTransferSummary {
  sender: string;
  receiver: string;
  amount: string;
}

export interface NormalizedNearTransfer {
  transfer: NearTransferSummary;
  canonicalBytes: string;
  payloadHash: string;
}

function isNearAccountId(value: string): boolean {
  return value.length >= 2 && value.length <= 64 && /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(value);
}

export function normalizeNearTransfer(value: unknown): NormalizedNearTransfer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('transfer must be an object containing sender, receiver, and amount.');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3 || Object.keys(record).some((key) => !['sender', 'receiver', 'amount'].includes(key))) {
    throw new Error('transfer must contain only sender, receiver, and amount.');
  }
  const { sender, receiver, amount } = record;
  if (typeof sender !== 'string' || !isNearAccountId(sender) || typeof receiver !== 'string' || !isNearAccountId(receiver)) {
    throw new Error('transfer sender and receiver must be valid NEAR account IDs.');
  }
  if (typeof amount !== 'string' || !/^[1-9]\d{0,77}$/.test(amount)) {
    throw new Error('transfer amount must be a positive integer string in yoctoNEAR.');
  }
  const transfer = { sender, receiver, amount };
  const canonicalBytes = JSON.stringify(transfer);
  return {
    transfer,
    canonicalBytes,
    payloadHash: createHash('sha256').update(canonicalBytes, 'utf8').digest('hex'),
  };
}

export function evaluateNearTransferPolicy(
  transfer: NearTransferSummary,
  policy: AsguardPolicy,
  verifiedUsdValue?: number,
): { blockedReasons: string[]; humanReviewReasons: string[] } {
  const blockedReasons: string[] = [];
  const humanReviewReasons: string[] = [];
  const includes = (values: string[] | undefined, target: string) => values?.some((value) => value.toLowerCase() === target.toLowerCase()) ?? false;

  if (includes(policy.denied_destinations, transfer.receiver)) blockedReasons.push('destination_denied');
  if (policy.allowed_destinations?.length && !includes(policy.allowed_destinations, transfer.receiver)) {
    humanReviewReasons.push('destination_not_allowlisted');
  }
  if (typeof verifiedUsdValue !== 'number' || !Number.isFinite(verifiedUsdValue) || verifiedUsdValue < 0) {
    humanReviewReasons.push('usd_value_unverified');
  } else if (verifiedUsdValue > policy.max_auto_trade_usd) {
    blockedReasons.push('budget_overrun');
  }
  if (!policy.allowed_destinations?.length) humanReviewReasons.push('destination_not_allowlisted');
  humanReviewReasons.push('near_transfer_requires_human_review');
  return { blockedReasons: [...new Set(blockedReasons)], humanReviewReasons: [...new Set(humanReviewReasons)] };
}
