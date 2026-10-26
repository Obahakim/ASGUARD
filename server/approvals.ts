import crypto from 'node:crypto';
import type { AgentActivityEvent, SignApprovalRequest, SignApprovalResponse, HITLRequestEvent } from './types';
import type { ApiIdentity } from './auth';
import { validateApprovalRequest, issueApprovalAttestation, DEFAULT_APPROVAL_TTL_MS } from './approvalAttestation';
import { createTransactionIntent, recordPreflight, transitionTransactionIntent } from './transactionIntentStore';
import { hitlHandler } from './hitlHandler';
import { notifier } from './notifier';
import { auditAnchor } from './aos/auditAnchor';
import { chainRegistry } from './aos/chainRegistry';
import { policyStore } from './policyStore';
import type AnomalyEngine from './anomalyEngine';
import { logger } from './logger';
import { evaluateNearIntentPolicy, normalizeNearIntent } from './aos/nearIntent';
import { nearAdapter } from './aos/nearAdapter';

const responseCache = new Map<string, { binding: string; response: SignApprovalResponse }>();
const requestResults = new Map<string, SignApprovalResponse>();
export function getApprovalResult(requestId: string): SignApprovalResponse | undefined {
  const complete = requestResults.get(requestId);
  if (complete) return complete;
  const pending = hitlHandler.getPendingRequest(requestId)?.event;
  return pending ? { status:'pending_hitl', request_id:requestId, intent_id:String(pending.context.intent_id ?? ''), reason:'human_approval_required' } : undefined;
}

export async function requestSignApproval(raw: Record<string, unknown>, identity: ApiIdentity, engine: AnomalyEngine, broadcast: (event: unknown) => void): Promise<SignApprovalResponse> {
  const input = raw as Partial<SignApprovalRequest>;
  try { validateApprovalRequest(input); }
  catch (error) { auditAnchor.record('approval_request_rejected', { agent_id: input.agent_id, actor_id: identity.id, reason: error instanceof Error ? error.message : 'invalid_request' }); throw error; }
  const request = input as SignApprovalRequest;
  const nearIntent = request.payload_domain === 'near-intent'
    ? normalizeNearIntent(request.near_intent, Date.now(), nearAdapter.intentsVerifier)
    : undefined;
  if (nearIntent && nearIntent.payloadHash !== request.payload_hash) {
    throw new Error('payload_hash does not match the canonical NEAR Intent.');
  }
  if (request.payload_domain === 'near-chain-signature') {
    if (!request.derivation_path?.trim()) throw new Error('derivation_path is required for Chain Signatures approval.');
    if (request.signer_contract !== nearAdapter.chainSignaturesContract) throw new Error('signer_contract does not match the configured NEAR Chain Signatures contract.');
  }
  if (request.payload_domain === 'near-intent' && request.chain?.toLowerCase() !== 'near') {
    throw new Error('NEAR Intent approvals must target the near chain.');
  }
  if (request.payload_domain === 'near-intent' && request.network !== `near:${nearAdapter.network}`) {
    throw new Error('NEAR Intent approvals must use the configured ASGUARD NEAR network.');
  }
  if (request.payload_domain === 'near-chain-signature'
    && (!request.chain || request.chain.toLowerCase() === 'near' || !request.network.includes(':'))) {
    throw new Error('Chain Signatures approvals require an explicit foreign chain and namespaced network.');
  }
  const policy = policyStore.getPolicy();
  const namespaced = request.network.includes(':');
  const [networkChain, ...netParts] = request.network.split(':');
  if (request.chain && namespaced && request.chain.toLowerCase() !== networkChain.toLowerCase()) throw new Error('chain does not match the namespace in network.');
  const chain = request.chain ?? (namespaced ? networkChain : undefined);
  const resolvedNetwork = namespaced ? netParts.join(':') : request.network;
  const network = chain ? `${chain}:${resolvedNetwork}` : request.network;
  const binding = crypto.createHash('sha256').update(JSON.stringify({
    agent_id: request.agent_id,
    agent_name: request.agent_name,
    action: request.action,
    risk_level: request.risk_level,
    payload_hash: request.payload_hash,
    payload_domain: request.payload_domain,
    network,
    chain: request.chain ?? chain,
    derivation_path: request.derivation_path,
    signer_contract: request.signer_contract,
    intent_type: nearIntent?.intent.intent_type ?? request.intent_type,
    amount_usd: request.amount_usd,
    ip_address: request.ip_address,
    device_id: request.device_id,
    contract_address: request.contract_address,
    wallet_id: request.wallet_id,
    details: request.details,
    policy_version: policy.version,
  })).digest('hex');
  const cached = responseCache.get(request.idempotency_key);
  if (cached) {
    if (cached.binding !== binding) throw new Error('idempotency_key is already bound to a different approval request or policy version.');
    return cached.response;
  }
  const cacheResponse = (response: SignApprovalResponse): SignApprovalResponse => {
    responseCache.set(request.idempotency_key, { binding, response });
    return response;
  };
  const verifiedUsdValue = nearIntent
    ? await nearAdapter.estimateUsdValue(nearIntent.movement.origin_asset, nearIntent.movement.amount)
    : undefined;
  const amountUsd = nearIntent
    ? verifiedUsdValue
    : request.payload_domain === 'near-chain-signature' ? undefined : request.amount_usd;
  const intent = createTransactionIntent({
    idempotency_key: request.idempotency_key, correlation_id: crypto.randomUUID(), agent_id: request.agent_id,
    wallet_id: request.wallet_id ?? '', network, chain: request.chain ?? chain, action: request.action,
    resource: nearIntent?.intent.recipient ?? request.contract_address ?? 'approval-request', payload_hash: request.payload_hash,
    payload_domain: request.payload_domain, derivation_path: request.derivation_path, signer_contract: request.signer_contract, intent_type: nearIntent?.intent.intent_type ?? request.intent_type,
    amount: amountUsd, policy_version: policy.version, risk_level: request.risk_level,
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  });
  if (intent.agent_id !== request.agent_id || intent.wallet_id !== (request.wallet_id ?? '')
    || intent.action !== request.action || intent.payload_hash !== request.payload_hash || intent.network !== network
    || intent.risk_level !== request.risk_level || intent.amount !== amountUsd
    || intent.payload_domain !== request.payload_domain || intent.derivation_path !== request.derivation_path
    || intent.signer_contract !== request.signer_contract || intent.intent_type !== (nearIntent?.intent.intent_type ?? request.intent_type)) {
    throw new Error('idempotency_key is already bound to a different approval payload.');
  }
  if (intent.status !== 'created') return { status: intent.status === 'pending_hitl' ? 'pending_hitl' : 'rejected', intent_id: intent.id, reason: 'duplicate_request_requires_original_response' };
  transitionTransactionIntent(intent.id, 'evaluating');
  const activity: AgentActivityEvent = { type:'agent_activity', timestamp:new Date().toISOString(), id:`evt_${crypto.randomUUID()}`, agent_id:request.agent_id, agent_name:request.agent_name, action:request.action, risk_level:request.risk_level === 'critical' ? 'high' : request.risk_level, chain:request.chain ?? chain, network:resolvedNetwork, details:{ ...(request.details ?? {}), ...(nearIntent ? { near_intent: nearIntent.movement, declared_amount_usd: nearIntent.movement.amount_usd } : {}) } };
  const result = await engine.processActivity(activity, { amount_usd:amountUsd, ip_address:request.ip_address, device_id:request.device_id, contract_address:nearIntent ? undefined : request.contract_address }, policy);
  const evaln = result.evaluation;
  const issue = (action:'approve_once'|'approve_session') => issueApprovalAttestation({ decision_id:`dec_${crypto.randomUUID()}`, intent_id:intent.id, agent_id:request.agent_id, payload_hash:request.payload_hash, network, chain:request.chain ?? chain, payload_domain:request.payload_domain, derivation_path:request.derivation_path, signer_contract:request.signer_contract, intent_type:nearIntent?.intent.intent_type ?? request.intent_type, action, max_amount_usd:request.payload_domain === 'near-chain-signature' ? undefined : amountUsd, expires_at:new Date(Date.now()+DEFAULT_APPROVAL_TTL_MS).toISOString(), anomaly_score:evaln.anomaly_score, rules_triggered:evaln.rules_triggered, issued_at:new Date().toISOString(), policy_version:policy.version });
  const intentPolicy = nearIntent ? evaluateNearIntentPolicy(nearIntent, policy, new Date(), verifiedUsdValue) : undefined;
  const hardBlockReason = intentPolicy?.blockedReasons[0]
    ?? (amountUsd !== undefined && amountUsd > policy.max_auto_trade_usd ? 'budget_overrun' : undefined);
  if (hardBlockReason) {
    recordPreflight(intent.id, { kind: nearIntent ? 'near_intent_policy_and_price' : 'approval_policy', status: 'blocked', checked_at: new Date().toISOString(), reasons: [...(intentPolicy?.blockedReasons ?? []), hardBlockReason] });
    transitionTransactionIntent(intent.id, 'blocked'); auditAnchor.record('approval_rejected',{intent_id:intent.id,agent_id:request.agent_id,reason:hardBlockReason,actor_id:identity.id});
    const response: SignApprovalResponse = { status:'rejected', intent_id:intent.id, reason:hardBlockReason, anomaly:evaln }; return cacheResponse(response);
  }
  const targetAdapter = chainRegistry.resolve(chain ?? request.network, chain ? resolvedNetwork : undefined);
  const requiresHuman = evaln.action === 'halt_and_hitl'
    || request.risk_level === 'high'
    || request.risk_level === 'critical'
    || Boolean(intentPolicy?.requiresHuman)
    || request.payload_domain === 'near-chain-signature'
    || (chain === 'near' && request.payload_domain !== 'near-intent')
    || 'approvalOnly' in targetAdapter;
  const preflightReasons = intentPolicy?.humanReviewReasons ?? (requiresHuman ? evaln.rules_triggered.map((rule) => rule.rule_id) : []);
  const preflight = { kind: nearIntent ? 'near_intent_policy_and_price' as const : 'approval_policy' as const, status: requiresHuman ? 'review_required' as const : 'passed' as const, checked_at: new Date().toISOString(), reasons: preflightReasons };
  recordPreflight(intent.id, preflight);
  if (!requiresHuman) {
    transitionTransactionIntent(intent.id,'approved'); const attestation=issue('approve_once'); auditAnchor.record('approval_issued',{intent_id:intent.id,agent_id:request.agent_id,score:evaln.anomaly_score,path:evaln.action,network,chain:request.chain??chain,payload_hash:request.payload_hash,payload_domain:request.payload_domain,derivation_path:request.derivation_path,signer_contract:request.signer_contract,intent_type:nearIntent?.intent.intent_type??request.intent_type});
    const response:SignApprovalResponse={status:'approved',intent_id:intent.id,decision_id:attestation.decision_id,attestation,anomaly:evaln};return cacheResponse(response);
  }
  transitionTransactionIntent(intent.id,'pending_hitl');
  const event: HITLRequestEvent = {type:'hitl_request',timestamp:new Date().toISOString(),id:`hitl_${crypto.randomUUID()}`,request_id:`req_${crypto.randomUUID()}`,agent_id:request.agent_id,incident_type:'sign_approval',context:{intent_id:intent.id,action:request.action,amount_usd:amountUsd,score:evaln.anomaly_score,rules:evaln.rules_triggered,network,chain:request.chain??chain,payload_domain:request.payload_domain,intent_type:nearIntent?.intent.intent_type??request.intent_type,near_intent:nearIntent?.intent,derivation_path:request.derivation_path,signer_contract:request.signer_contract,human_review_reasons:intentPolicy?.humanReviewReasons,preflight},action_options:['allow_once','allow_session','deny_terminate'],expires_at:intent.expires_at};
  broadcast(event);
  void notifier.notifyForDecision({agent_id:request.agent_id,action:request.action,amount_usd:amountUsd,request_id:event.request_id,status:'pending_hitl',expires_at:event.expires_at,score:evaln.anomaly_score,rules:evaln.rules_triggered,requires_hitl:true}).catch(error=>logger.error('[Approval] Notifier failed',{error:String(error)}));
  auditAnchor.record('approval_pending_hitl',{intent_id:intent.id,request_id:event.request_id,agent_id:request.agent_id,score:evaln.anomaly_score,network});
  const pendingResponse: SignApprovalResponse = { status:'pending_hitl', intent_id:intent.id, request_id:event.request_id, reason:'human_approval_required', anomaly:evaln };
  cacheResponse(pendingResponse);
  requestResults.set(event.request_id, pendingResponse);
  void (async () => {
    try {
      const decision = await hitlHandler.handleRequest(event,false);
      auditAnchor.record('approval_hitl_decision',{intent_id:intent.id,request_id:event.request_id,actor_id:decision.actor_id??'timeout',decision:decision.action,reason:decision.reason});
      let finalResponse: SignApprovalResponse;
      if (decision.action === 'deny_terminate') {
        transitionTransactionIntent(intent.id,'rejected');
        finalResponse = {status:'rejected',intent_id:intent.id,request_id:event.request_id,reason:decision.reason === 'Request expired' ? 'timeout_deny' : decision.reason ?? 'human_denied',anomaly:evaln};
      } else {
        const attestation=issue(decision.action==='allow_session'?'approve_session':'approve_once');
        transitionTransactionIntent(intent.id,'approved');
        auditAnchor.record('approval_issued',{intent_id:intent.id,agent_id:request.agent_id,request_id:event.request_id,actor_id:decision.actor_id,decision:decision.action,network,payload_hash:request.payload_hash,payload_domain:request.payload_domain,derivation_path:request.derivation_path,signer_contract:request.signer_contract,intent_type:nearIntent?.intent.intent_type??request.intent_type});
        finalResponse={status:'approved',intent_id:intent.id,request_id:event.request_id,decision_id:attestation.decision_id,attestation,anomaly:evaln};
      }
      cacheResponse(finalResponse);requestResults.set(event.request_id,finalResponse);
    } catch(error) {
      try { transitionTransactionIntent(intent.id,'rejected'); } catch { /* already finalized */ }
      const finalResponse:SignApprovalResponse={status:'rejected',intent_id:intent.id,request_id:event.request_id,reason:'approval_finalization_failed'};
      cacheResponse(finalResponse);requestResults.set(event.request_id,finalResponse);
      auditAnchor.record('approval_rejected',{intent_id:intent.id,request_id:event.request_id,reason:'approval_finalization_failed',error:String(error)});
    }
  })();
  return pendingResponse;
}

export async function requestNearIntentApproval(
  raw: Record<string, unknown>,
  identity: ApiIdentity,
  engine: AnomalyEngine,
  broadcast: (event: unknown) => void
): Promise<SignApprovalResponse> {
  const normalized = normalizeNearIntent(raw.near_intent, Date.now(), nearAdapter.intentsVerifier);
  const network = `near:${nearAdapter.network}`;
  if (raw.network !== undefined && raw.network !== network) throw new Error('NEAR Intent network does not match the configured ASGUARD NEAR network.');
  if (raw.amount_usd !== undefined && raw.amount_usd !== normalized.movement.amount_usd) {
    throw new Error('amount_usd must be included in the canonical NEAR Intent, not supplied separately.');
  }
  return requestSignApproval({
    ...raw,
    action: typeof raw.action === 'string' ? raw.action : `near-intent:${normalized.intent.intent_type}`,
    payload_hash: normalized.payloadHash,
    payload_domain: 'near-intent',
    intent_type: normalized.intent.intent_type,
    near_intent: raw.near_intent as Record<string, unknown>,
    chain: 'near',
    network,
    amount_usd: normalized.movement.amount_usd,
  }, identity, engine, broadcast);
}

export async function requestChainSignatureApproval(
  raw: Record<string, unknown>,
  identity: ApiIdentity,
  engine: AnomalyEngine,
  broadcast: (event: unknown) => void
): Promise<SignApprovalResponse> {
  const derivationPath = raw.derivation_path;
  if (typeof derivationPath !== 'string' || !/^[A-Za-z0-9._:/-]{1,128}$/.test(derivationPath)) {
    throw new Error('A valid Chain Signatures derivation_path is required.');
  }
  return requestSignApproval({
    ...raw,
    payload_domain: 'near-chain-signature',
    derivation_path: derivationPath,
    signer_contract: nearAdapter.chainSignaturesContract,
  }, identity, engine, broadcast);
}
