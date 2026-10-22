import crypto from 'node:crypto';
import type { AgentActivityEvent, SignApprovalRequest, SignApprovalResponse, HITLRequestEvent } from './types';
import type { ApiIdentity } from './auth';
import { validateApprovalRequest, issueApprovalAttestation, DEFAULT_APPROVAL_TTL_MS } from './approvalAttestation';
import { createTransactionIntent, transitionTransactionIntent } from './transactionIntentStore';
import { hitlHandler } from './hitlHandler';
import { notifier } from './notifier';
import { auditAnchor } from './aos/auditAnchor';
import { chainRegistry } from './aos/chainRegistry';
import { policyStore } from './policyStore';
import type AnomalyEngine from './anomalyEngine';
import { logger } from './logger';

const responseCache = new Map<string, SignApprovalResponse>();
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
  const cached = responseCache.get(request.idempotency_key);
  if (cached) return cached;
  const policy = policyStore.getPolicy();
  const namespaced = request.network.includes(':');
  const [networkChain, ...netParts] = request.network.split(':');
  if (request.chain && namespaced && request.chain.toLowerCase() !== networkChain.toLowerCase()) throw new Error('chain does not match the namespace in network.');
  const chain = request.chain ?? (namespaced ? networkChain : undefined);
  const resolvedNetwork = namespaced ? netParts.join(':') : request.network;
  const network = chain ? `${chain}:${resolvedNetwork}` : request.network;
  const intent = createTransactionIntent({
    idempotency_key: request.idempotency_key, correlation_id: crypto.randomUUID(), agent_id: request.agent_id,
    wallet_id: request.wallet_id ?? '', network, chain: request.chain ?? chain, action: request.action,
    resource: request.contract_address ?? 'approval-request', payload_hash: request.payload_hash,
    amount: request.amount_usd, policy_version: policy.version, risk_level: request.risk_level,
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  });
  if (intent.agent_id !== request.agent_id || intent.payload_hash !== request.payload_hash || intent.network !== network) throw new Error('idempotency_key is already bound to a different approval payload.');
  if (intent.status !== 'created') return { status: intent.status === 'pending_hitl' ? 'pending_hitl' : 'rejected', intent_id: intent.id, reason: 'duplicate_request_requires_original_response' };
  transitionTransactionIntent(intent.id, 'evaluating');
  const activity: AgentActivityEvent = { type:'agent_activity', timestamp:new Date().toISOString(), id:`evt_${crypto.randomUUID()}`, agent_id:request.agent_id, agent_name:request.agent_name, action:request.action, risk_level:request.risk_level, chain:request.chain ?? chain, network:resolvedNetwork, details:request.details ?? {} };
  const result = await engine.processActivity(activity, { amount_usd:request.amount_usd, ip_address:request.ip_address, device_id:request.device_id, contract_address:request.contract_address }, policy);
  const evaln = result.evaluation;
  const issue = (action:'approve_once'|'approve_session') => issueApprovalAttestation({ decision_id:`dec_${crypto.randomUUID()}`, intent_id:intent.id, agent_id:request.agent_id, payload_hash:request.payload_hash, network, chain:request.chain ?? chain, action, max_amount_usd:request.amount_usd, expires_at:new Date(Date.now()+DEFAULT_APPROVAL_TTL_MS).toISOString(), anomaly_score:evaln.anomaly_score, rules_triggered:evaln.rules_triggered, issued_at:new Date().toISOString(), policy_version:policy.version });
  if (request.amount_usd !== undefined && request.amount_usd > policy.max_auto_trade_usd) {
    transitionTransactionIntent(intent.id, 'blocked'); auditAnchor.record('approval_rejected',{intent_id:intent.id,agent_id:request.agent_id,reason:'budget_overrun',actor_id:identity.id});
    const response: SignApprovalResponse = { status:'rejected', intent_id:intent.id, reason:'budget_overrun', anomaly:evaln }; responseCache.set(request.idempotency_key,response); return response;
  }
  const simData = request.simulation?.transaction_base64;
  if (simData !== undefined) {
    const adapter = chainRegistry.resolve(chain, resolvedNetwork);
    if (!('simulateSignedTransaction' in adapter) || typeof simData !== 'string') { transitionTransactionIntent(intent.id,'blocked'); auditAnchor.record('approval_rejected',{intent_id:intent.id,reason:'simulation_unsupported',network}); const response:SignApprovalResponse={status:'rejected',intent_id:intent.id,reason:'simulation_unsupported',anomaly:evaln};responseCache.set(request.idempotency_key,response);return response; }
    try { const sim=await adapter.simulateSignedTransaction(simData); if(sim.err !== null){transitionTransactionIntent(intent.id,'blocked');auditAnchor.record('approval_rejected',{intent_id:intent.id,reason:'simulation_failed'});const response:SignApprovalResponse={status:'rejected',intent_id:intent.id,reason:'simulation_failed',anomaly:evaln};responseCache.set(request.idempotency_key,response);return response;} }
    catch(error){transitionTransactionIntent(intent.id,'blocked');auditAnchor.record('approval_rejected',{intent_id:intent.id,reason:'simulation_error',error:String(error)});const response:SignApprovalResponse={status:'rejected',intent_id:intent.id,reason:'simulation_failed',anomaly:evaln};responseCache.set(request.idempotency_key,response);return response;}
  }
  if (evaln.action !== 'halt_and_hitl') {
    transitionTransactionIntent(intent.id,'approved'); const attestation=issue('approve_once'); auditAnchor.record('approval_issued',{intent_id:intent.id,agent_id:request.agent_id,score:evaln.anomaly_score,path:evaln.action,network,chain:request.chain??chain});
    const response:SignApprovalResponse={status:'approved',intent_id:intent.id,decision_id:attestation.decision_id,attestation,anomaly:evaln};responseCache.set(request.idempotency_key,response);return response;
  }
  transitionTransactionIntent(intent.id,'pending_hitl');
  const event: HITLRequestEvent = {type:'hitl_request',timestamp:new Date().toISOString(),id:`hitl_${crypto.randomUUID()}`,request_id:`req_${crypto.randomUUID()}`,agent_id:request.agent_id,incident_type:'sign_approval',context:{intent_id:intent.id,action:request.action,amount_usd:request.amount_usd,score:evaln.anomaly_score,rules:evaln.rules_triggered,network,chain:request.chain??chain},action_options:['allow_once','allow_session','deny_terminate'],expires_at:intent.expires_at};
  broadcast(event);
  void notifier.notifyForDecision({agent_id:request.agent_id,action:request.action,amount_usd:request.amount_usd,request_id:event.request_id,status:'pending_hitl',expires_at:event.expires_at,score:evaln.anomaly_score,rules:evaln.rules_triggered,requires_hitl:true}).catch(error=>logger.error('[Approval] Notifier failed',{error:String(error)}));
  auditAnchor.record('approval_pending_hitl',{intent_id:intent.id,request_id:event.request_id,agent_id:request.agent_id,score:evaln.anomaly_score,network});
  const pendingResponse: SignApprovalResponse = { status:'pending_hitl', intent_id:intent.id, request_id:event.request_id, reason:'human_approval_required', anomaly:evaln };
  responseCache.set(request.idempotency_key, pendingResponse);
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
        auditAnchor.record('approval_issued',{intent_id:intent.id,agent_id:request.agent_id,request_id:event.request_id,actor_id:decision.actor_id,decision:decision.action,network});
        finalResponse={status:'approved',intent_id:intent.id,request_id:event.request_id,decision_id:attestation.decision_id,attestation,anomaly:evaln};
      }
      responseCache.set(request.idempotency_key,finalResponse);requestResults.set(event.request_id,finalResponse);
    } catch(error) {
      try { transitionTransactionIntent(intent.id,'rejected'); } catch { /* already finalized */ }
      const finalResponse:SignApprovalResponse={status:'rejected',intent_id:intent.id,request_id:event.request_id,reason:'approval_finalization_failed'};
      responseCache.set(request.idempotency_key,finalResponse);requestResults.set(event.request_id,finalResponse);
      auditAnchor.record('approval_rejected',{intent_id:intent.id,request_id:event.request_id,reason:'approval_finalization_failed',error:String(error)});
    }
  })();
  return pendingResponse;
}
