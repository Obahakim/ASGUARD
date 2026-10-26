import { createHash } from 'node:crypto';
import type { AsguardPolicy } from '../types';

export interface CanonicalNearIntent {
  schema: 'asguard.near-intent.v1';
  verifier_contract: string;
  intent_type: string;
  origin_asset: string;
  destination_asset: string;
  amount: string;
  min_output_amount?: string;
  recipient?: string;
  destination_chain?: string;
  deadline?: string;
  max_slippage_bps?: number;
  amount_usd?: number;
  quote_id?: string;
  extensions?: Record<string, unknown>;
}

export interface NormalizedNearIntent {
  intent: CanonicalNearIntent;
  canonicalBytes: string;
  payloadHash: string;
  containsOpaqueExtensions: boolean;
  movement: {
    intent_type: string;
    origin_asset: string;
    destination_asset: string;
    amount: string;
    min_output_amount?: string;
    recipient?: string;
    destination_chain?: string;
    deadline?: string;
    max_slippage_bps?: number;
    amount_usd?: number;
  };
}

export interface NearIntentPolicyResult {
  blocked: boolean;
  blockedReasons: string[];
  requiresHuman: boolean;
  humanReviewReasons: string[];
}

const ALLOWED_FIELDS = new Set([
  'intent_type', 'origin_asset', 'destination_asset', 'amount', 'min_output_amount',
  'recipient', 'destination_chain', 'deadline', 'max_slippage_bps', 'amount_usd',
  'quote_id', 'extensions',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`;
  }
  throw new Error('Intent extensions must contain only JSON values.');
}

function requiredString(source: Record<string, unknown>, field: string, maxLength: number): string {
  const value = source[field];
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || value !== value.trim()) {
    throw new Error(`${field} must be a non-empty trimmed string of at most ${maxLength} characters.`);
  }
  return value;
}

function optionalString(source: Record<string, unknown>, field: string, maxLength: number): string | undefined {
  if (source[field] === undefined) return undefined;
  return requiredString(source, field, maxLength);
}

function tokenAmount(source: Record<string, unknown>, field: string, optional = false): string | undefined {
  const value = source[field];
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || value.length > 39 || !/^(0|[1-9]\d*)$/.test(value)
    || BigInt(value) <= 0n || BigInt(value) >= 2n ** 128n) {
    throw new Error(`${field} must be a positive base-10 integer string in the asset's smallest unit.`);
  }
  return value;
}

function normalizeExtensions(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('extensions must be a JSON object.');
  const serialized = canonicalize(value);
  return JSON.parse(serialized) as Record<string, unknown>;
}

function normalizeSignedIntentEnvelope(input: Record<string, unknown>, verifierContract: string): Record<string, unknown> | undefined {
  if (input.standard === undefined && input.payload === undefined) return undefined;
  for (const key of Object.keys(input)) {
    if (!['standard', 'payload', 'amount_usd', 'max_slippage_bps'].includes(key)) {
      throw new Error(`Unsupported signed NEAR Intent envelope field: ${key}.`);
    }
  }
  if (typeof input.standard !== 'string' || !/^[a-z0-9_-]{1,32}$/i.test(input.standard)) {
    throw new Error('Signed NEAR Intent standard is invalid.');
  }
  if (!isRecord(input.payload)) throw new Error('Signed NEAR Intent payload must be an object.');
  if (Object.keys(input.payload).some(key => !['recipient', 'nonce', 'message'].includes(key))) {
    throw new Error('Signed NEAR Intent payload contains unsupported fields.');
  }
  const payloadRecipient = requiredString(input.payload, 'recipient', 128);
  if (payloadRecipient !== verifierContract) throw new Error('Signed NEAR Intent recipient does not match the configured verifier contract.');
  const nonce = requiredString(input.payload, 'nonce', 128);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(nonce) || Buffer.from(nonce, 'base64').length !== 32) {
    throw new Error('Signed NEAR Intent nonce must encode exactly 32 bytes.');
  }
  const message = requiredString(input.payload, 'message', 100_000);
  let parsedMessage: unknown;
  try {
    parsedMessage = JSON.parse(message);
  } catch {
    throw new Error('Signed NEAR Intent message must contain valid JSON.');
  }
  if (!isRecord(parsedMessage) || !Array.isArray(parsedMessage.intents) || parsedMessage.intents.length !== 1) {
    throw new Error('Signed NEAR Intent must contain exactly one supported intent.');
  }
  if (Object.keys(parsedMessage).some(key => !['deadline', 'intents', 'signer_id', 'recipient'].includes(key))) {
    throw new Error('Signed NEAR Intent message contains unsupported fields.');
  }
  const signerId = requiredString(parsedMessage, 'signer_id', 128);
  const tokenIntent = parsedMessage.intents[0];
  if (!isRecord(tokenIntent) || tokenIntent.intent !== 'token_diff' || !isRecord(tokenIntent.diff)) {
    throw new Error('Only NEAR token_diff intents are currently supported.');
  }
  if (Object.keys(tokenIntent).some(key => !['intent', 'diff'].includes(key))) {
    throw new Error('NEAR token_diff contains unsupported fields.');
  }
  const changes = Object.entries(tokenIntent.diff);
  if (changes.length !== 2) throw new Error('NEAR token_diff must contain exactly one input and one output asset.');
  const parsedChanges = changes.map(([asset, amount]) => {
    if (!asset.trim() || typeof amount !== 'string' || amount.length > 40 || !/^-?[1-9]\d*$/.test(amount)
      || BigInt(amount) <= -(2n ** 128n) || BigInt(amount) >= 2n ** 128n) {
      throw new Error('NEAR token_diff asset changes must be non-zero integer strings.');
    }
    return { asset, amount: BigInt(amount) };
  });
  const inputs = parsedChanges.filter(change => change.amount < 0n);
  const outputs = parsedChanges.filter(change => change.amount > 0n);
  if (inputs.length !== 1 || outputs.length !== 1) {
    throw new Error('NEAR token_diff must have one negative input and one positive output.');
  }
  const deadline = requiredString(parsedMessage, 'deadline', 64);
  const destinationAsset = outputs[0].asset;
  const destinationChain = typeof parsedMessage.destination_chain === 'string'
    ? parsedMessage.destination_chain
    : inferNearIntentChain(destinationAsset);
  const recipient = typeof parsedMessage.recipient === 'string' ? parsedMessage.recipient : undefined;
  return {
    intent_type: 'token_diff',
    origin_asset: inputs[0].asset,
    destination_asset: destinationAsset,
    amount: (-inputs[0].amount).toString(),
    min_output_amount: outputs[0].amount.toString(),
    ...(recipient ? { recipient } : {}),
    ...(destinationChain ? { destination_chain: destinationChain } : {}),
    deadline,
    ...(input.max_slippage_bps !== undefined ? { max_slippage_bps: input.max_slippage_bps } : {}),
    ...(input.amount_usd !== undefined ? { amount_usd: input.amount_usd } : {}),
    extensions: { signer_id: signerId, signed_intent_standard: input.standard, signed_intent_payload: input.payload },
  };
}

function inferNearIntentChain(asset: string): string | undefined {
  if (asset === 'nep141:wrap.near') return 'near';
  const tokenId = asset.startsWith('nep141:') ? asset.slice('nep141:'.length) : '';
  const prefixes: Record<string, string> = {
    arb: 'arbitrum', eth: 'ethereum', base: 'base', bsc: 'bnb', btc: 'bitcoin',
    xrp: 'xrp', doge: 'dogecoin', sui: 'sui', apt: 'aptos',
  };
  const prefix = tokenId.match(/^([a-z]+)-/)?.[1];
  return prefix ? prefixes[prefix] : undefined;
}

export function normalizeNearIntent(
  input: unknown,
  now = Date.now(),
  verifierContract = process.env.ASGUARD_NEAR_INTENTS_VERIFIER || 'intents.near'
): NormalizedNearIntent {
  if (!isRecord(input)) throw new Error('NEAR intent must be a JSON object.');
  const signedEnvelope = normalizeSignedIntentEnvelope(input, verifierContract);
  const source = signedEnvelope ?? input;
  for (const key of Object.keys(source)) {
    if (!ALLOWED_FIELDS.has(key)) throw new Error(`Unsupported NEAR intent field: ${key}.`);
  }

  const intentType = requiredString(source, 'intent_type', 64);
  const originAsset = requiredString(source, 'origin_asset', 256);
  const destinationAsset = requiredString(source, 'destination_asset', 256);
  const amount = tokenAmount(source, 'amount')!;
  const minOutputAmount = tokenAmount(source, 'min_output_amount', true);
  const recipient = optionalString(source, 'recipient', 256);
  const destinationChain = optionalString(source, 'destination_chain', 64);
  const deadline = optionalString(source, 'deadline', 64);
  const quoteId = optionalString(source, 'quote_id', 256);
  const amountUsd = source.amount_usd;
  if (amountUsd !== undefined && (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd) || amountUsd < 0)) {
    throw new Error('amount_usd must be a non-negative finite number.');
  }
  const maxSlippageBps = source.max_slippage_bps;
  if (maxSlippageBps !== undefined && (!Number.isInteger(maxSlippageBps) || (maxSlippageBps as number) < 0 || (maxSlippageBps as number) > 10_000)) {
    throw new Error('max_slippage_bps must be an integer from 0 to 10000.');
  }
  if (deadline !== undefined) {
    const deadlineMs = Date.parse(deadline);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(deadline)
      || !Number.isFinite(deadlineMs) || deadlineMs <= now) throw new Error('deadline must be a future ISO-8601 timestamp.');
  }

  const intent: CanonicalNearIntent = {
    schema: 'asguard.near-intent.v1',
    verifier_contract: verifierContract,
    intent_type: intentType,
    origin_asset: originAsset,
    destination_asset: destinationAsset,
    amount,
    ...(minOutputAmount ? { min_output_amount: minOutputAmount } : {}),
    ...(recipient ? { recipient } : {}),
    ...(destinationChain ? { destination_chain: destinationChain } : {}),
    ...(deadline ? { deadline: new Date(deadline).toISOString() } : {}),
    ...(maxSlippageBps !== undefined ? { max_slippage_bps: maxSlippageBps as number } : {}),
    ...(amountUsd !== undefined ? { amount_usd: amountUsd as number } : {}),
    ...(quoteId ? { quote_id: quoteId } : {}),
    ...(source.extensions !== undefined ? { extensions: normalizeExtensions(source.extensions) } : {}),
  };
  const canonicalBytes = canonicalize(intent);
  const payloadHash = createHash('sha256').update(canonicalBytes, 'utf8').digest('hex');
  const movement = {
    intent_type: intent.intent_type,
    origin_asset: intent.origin_asset,
    destination_asset: intent.destination_asset,
    amount: intent.amount,
    ...(intent.min_output_amount ? { min_output_amount: intent.min_output_amount } : {}),
    ...(intent.recipient ? { recipient: intent.recipient } : {}),
    ...(intent.destination_chain ? { destination_chain: intent.destination_chain } : {}),
    ...(intent.deadline ? { deadline: intent.deadline } : {}),
    ...(intent.max_slippage_bps !== undefined ? { max_slippage_bps: intent.max_slippage_bps } : {}),
    ...(intent.amount_usd !== undefined ? { amount_usd: intent.amount_usd } : {}),
  };
  return { intent, canonicalBytes, payloadHash, containsOpaqueExtensions: !signedEnvelope && Boolean(intent.extensions), movement };
}

function includesCaseInsensitive(values: string[] | undefined, value: string): boolean {
  return values?.some(candidate => candidate.toLowerCase() === value.toLowerCase()) ?? false;
}

export function evaluateNearIntentPolicy(
  normalized: NormalizedNearIntent,
  policy: AsguardPolicy,
  now = new Date(),
  verifiedUsdValue?: number
): NearIntentPolicyResult {
  const { intent, movement } = normalized;
  const blockedReasons: string[] = [];
  const humanReviewReasons: string[] = [];
  const assets = [movement.origin_asset, movement.destination_asset];

  if (includesCaseInsensitive(policy.denied_intent_types, intent.intent_type)) blockedReasons.push('intent_type_denied');
  if (policy.allowed_intent_types?.length && !includesCaseInsensitive(policy.allowed_intent_types, intent.intent_type)) {
    humanReviewReasons.push('intent_type_not_allowlisted');
  }
  if (assets.some(asset => includesCaseInsensitive(policy.denied_assets, asset))) blockedReasons.push('asset_denied');
  if (policy.allowed_assets?.length && assets.some(asset => !includesCaseInsensitive(policy.allowed_assets, asset))) {
    humanReviewReasons.push('asset_not_allowlisted');
  }
  if (movement.recipient && includesCaseInsensitive(policy.denied_destinations, movement.recipient)) {
    blockedReasons.push('destination_denied');
  }
  if (policy.allowed_destinations?.length && (!movement.recipient || !includesCaseInsensitive(policy.allowed_destinations, movement.recipient))) {
    humanReviewReasons.push('destination_not_allowlisted');
  }
  if (movement.destination_chain && includesCaseInsensitive(policy.denied_intent_chains, movement.destination_chain)) {
    blockedReasons.push('chain_denied');
  }
  if (policy.allowed_intent_chains?.length && (!movement.destination_chain || !includesCaseInsensitive(policy.allowed_intent_chains, movement.destination_chain))) {
    humanReviewReasons.push('chain_not_allowlisted');
  }
  if (typeof verifiedUsdValue !== 'number' || !Number.isFinite(verifiedUsdValue) || verifiedUsdValue < 0) {
    humanReviewReasons.push('usd_value_unverified');
  } else if (verifiedUsdValue > policy.max_auto_trade_usd) blockedReasons.push('budget_overrun');
  if (typeof movement.max_slippage_bps !== 'number') humanReviewReasons.push('slippage_unknown');
  else if (typeof policy.max_slippage_bps === 'number' && movement.max_slippage_bps > policy.max_slippage_bps) {
    blockedReasons.push('slippage_exceeds_policy');
  }
  if (!policy.allowed_assets?.length) humanReviewReasons.push('assets_not_allowlisted');
  if (!policy.allowed_destinations?.length) humanReviewReasons.push('destination_not_allowlisted');
  if (!policy.allowed_intent_chains?.length) humanReviewReasons.push('chain_not_allowlisted');
  if (policy.intent_unknown_target_requires_hitl !== false && (!movement.recipient || !movement.destination_chain)) {
    humanReviewReasons.push('target_incomplete');
  }
  if (normalized.containsOpaqueExtensions) humanReviewReasons.push('opaque_intent_extensions');
  if (movement.destination_chain && ![
    'near', 'arbitrum', 'ethereum', 'base', 'bnb', 'bitcoin', 'xrp', 'dogecoin', 'sui', 'aptos',
  ].includes(movement.destination_chain.toLowerCase())) humanReviewReasons.push('unsupported_destination_chain');
  if (policy.allowed_intent_hours_utc?.length && !policy.allowed_intent_hours_utc.includes(now.getUTCHours())) {
    blockedReasons.push('outside_allowed_time_window');
  }

  const uniqueBlockedReasons = [...new Set(blockedReasons)];
  const uniqueHumanReasons = [...new Set(humanReviewReasons)];
  return {
    blocked: uniqueBlockedReasons.length > 0,
    blockedReasons: uniqueBlockedReasons,
    requiresHuman: uniqueHumanReasons.length > 0,
    humanReviewReasons: uniqueHumanReasons,
  };
}
