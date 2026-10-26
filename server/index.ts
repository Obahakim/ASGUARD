/**
 * Asguard Backend Server
 * Main entry point - initializes HTTP/WebSocket server and REST API
 */

import express, { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import http from 'http';
import { WebSocketBridge } from './bridge';
import { policyStore } from './policyStore';
import { logger } from './logger';
import { hitlHandler } from './hitlHandler';
import AnomalyEngine from './anomalyEngine';
import { ApiAuthenticator, parseApiCredentials } from './auth';
import {
  PolicyUpdateRequest,
  PolicyResponse,
  HealthCheckResponse,
  Event,
  HITLRequestEvent,
  AgentActivityEvent,
} from './types';
import { CapabilityManager, defaultCapabilities } from './aos/capabilityManager';
import { runtimeBridge } from './aos/runtimeBridge';
import { auditAnchor } from './aos/auditAnchor';
import { capsuleConfig } from './aos/capsuleConfig';
import { providerRegistry } from './aos/providerRegistry';
import { runtimeConfig } from './aos/runtimeConfig';
import { UnicityAdapter } from './aos/unicityAdapter';
import { createWalletChallenge, verifyWalletChallenge } from './aos/agentSphereAuth';
import { createTransactionIntent, getTransactionIntent, listTransactionIntents, recordSimulation, transitionTransactionIntent } from './transactionIntentStore';
import { consumeWebSocketTicket, issueWebSocketTicket } from './wsTicket';
import { createSolanaDevnetAdapter } from './aos/chainAdapter';
import { nearAdapter } from './aos/nearAdapter';
import { chainRegistry } from './aos/chainRegistry';
import {
  getApprovalResult,
  requestSignApproval as processSignApproval,
  requestNearIntentApproval as processNearIntentApproval,
  requestChainSignatureApproval as processChainSignatureApproval,
} from './approvals';
import { notifier } from './notifier';
import { handleMcpRequest } from './mcp';

// Configuration
const PORT = process.env.ASGUARD_PORT || 8080;
const HOST = process.env.ASGUARD_HOST || 'localhost';
const runtimeName = process.env.ASGUARD_RUNTIME || 'astrid';
process.env.ASGUARD_RUNTIME = runtimeName;
const apiAuthenticator = new ApiAuthenticator(parseApiCredentials());
const allowedOrigins = new Set(
  (process.env.ASGUARD_ALLOWED_ORIGINS || 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
);

const capabilityManager = new CapabilityManager(defaultCapabilities);
runtimeBridge.connect();
const unicityAdapter = new UnicityAdapter();
if (process.env.ASGUARD_ENABLE_SOLANA_ADAPTER === 'true') {
  chainRegistry.register('solana', createSolanaDevnetAdapter());
}

// Initialize Express app
const app = express();
const httpServer = http.createServer(app);

// Middleware
// CORS middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.get('Origin');
  if (origin && !allowedOrigins.has(origin)) {
    res.status(403).json({ success: false, error: 'Origin is not allowed.' });
    return;
  }
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
    res.vary('Origin');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Asguard-Key');

  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

app.use('/api', apiAuthenticator.authenticationMiddleware());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Initialize WebSocket bridge
const bridge = new WebSocketBridge(httpServer, Number(PORT), consumeWebSocketTicket, allowedOrigins);
logger.setBridge(bridge);

// Initialize anomaly engine (Phase 3)
const anomalyEngine = new AnomalyEngine();

async function reportMcpActivity(input: Record<string, unknown>, identity: NonNullable<Request['asguardIdentity']>) {
  const required = ['agent_id', 'agent_name', 'action'];
  if (required.some((key) => typeof input[key] !== 'string' || !(input[key] as string).trim())) {
    throw new Error('agent_id, agent_name, and action are required strings.');
  }
  if (!['low', 'medium', 'high'].includes(String(input.risk_level))) {
    throw new Error('risk_level must be low, medium, or high.');
  }
  if (input.amount_usd !== undefined && (typeof input.amount_usd !== 'number' || !Number.isFinite(input.amount_usd) || input.amount_usd < 0)) {
    throw new Error('amount_usd must be a non-negative finite number.');
  }
  const agentId = input.agent_id as string;
  const event: AgentActivityEvent = {
    type: 'agent_activity', timestamp: new Date().toISOString(), id: `evt_${crypto.randomUUID()}`,
    agent_id: agentId, agent_name: input.agent_name as string, action: input.action as string,
    risk_level: input.risk_level as AgentActivityEvent['risk_level'],
    chain: typeof input.chain === 'string' ? input.chain : undefined,
    network: typeof input.network === 'string' ? input.network : undefined,
    details: input.details && typeof input.details === 'object' && !Array.isArray(input.details)
      ? input.details as Record<string, unknown> : {},
  };
  auditAnchor.record('agent_activity', {
    agent_id: agentId, action: event.action, risk_level: event.risk_level,
    runtime: runtimeName, actor_id: identity.id, source: 'mcp',
  });
  const metadata = {
    amount_usd: input.amount_usd as number | undefined,
    ip_address: input.ip_address as string | undefined,
    device_id: input.device_id as string | undefined,
    contract_address: input.contract_address as string | undefined,
  };
  const result = await anomalyEngine.processActivity(event, metadata, policyStore.getPolicy());
  bridge.broadcastEvent(event);
  logger.broadcastEvent(event);
  if (result.anomaly_event) {
    bridge.broadcastEvent(result.anomaly_event);
    logger.broadcastEvent(result.anomaly_event);
  }
  if (result.should_trigger_hitl) {
    const hitlEvent: HITLRequestEvent = {
      type: 'hitl_request', timestamp: new Date().toISOString(), id: `hitl_${crypto.randomUUID()}`,
      request_id: `req_${crypto.randomUUID()}`, agent_id: agentId, incident_type: 'anomaly_detected',
      context: { anomaly_score: result.evaluation.anomaly_score, rules: result.evaluation.rules_triggered, activity: event },
      action_options: ['allow_once', 'allow_session', 'deny_terminate'],
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
    bridge.broadcastEvent(hitlEvent);
    logger.broadcastEvent(hitlEvent);
    void notifier.notifyForDecision({ agent_id: agentId, action: event.action, amount_usd: metadata.amount_usd, request_id: hitlEvent.request_id, status: 'pending_hitl', expires_at: hitlEvent.expires_at, score: result.evaluation.anomaly_score, rules: result.evaluation.rules_triggered, requires_hitl: true }).catch(error => logger.error('[MCP] Notifier failed', { error: String(error) }));
    void hitlHandler.handleRequest(hitlEvent).then((decision) => {
      bridge.broadcastEvent({
        type: 'audit_log', timestamp: new Date().toISOString(), id: `evt_${crypto.randomUUID()}`,
        agent_id: agentId, action: 'HITL Decision Applied', resource: hitlEvent.request_id,
        status: 'success', details: decision as unknown as Record<string, unknown>,
      });
    }).catch((error) => logger.error('[MCP] HITL handler error:', { error: String(error) }));
  }
  return { event, anomaly: result.evaluation, hitl_triggered: result.should_trigger_hitl };
}

async function reportMcpViolation(input: Record<string, unknown>, identity: NonNullable<Request['asguardIdentity']>) {
  if (typeof input.agent_id !== 'string' || !input.agent_id.trim() || typeof input.violation_type !== 'string' || !input.violation_type.trim()) {
    throw new Error('agent_id and violation_type are required strings.');
  }
  if (!['low', 'medium', 'high', 'critical'].includes(String(input.severity))) {
    throw new Error('severity must be low, medium, high, or critical.');
  }
  const context = input.context && typeof input.context === 'object' && !Array.isArray(input.context)
    ? input.context as Record<string, unknown> : {};
  const event: Event = {
    type: 'security_violation', timestamp: new Date().toISOString(), id: `evt_${crypto.randomUUID()}`,
    agent_id: input.agent_id, violation_type: input.violation_type, severity: input.severity as 'low' | 'medium' | 'high' | 'critical',
    requires_hitl: true, context: { ...context, source: 'mcp', reporter_id: identity.id },
  };
  auditAnchor.record('security_violation', {
    agent_id: event.agent_id, violation_type: event.violation_type, severity: event.severity,
    runtime: runtimeName, actor_id: identity.id, source: 'mcp',
  });
  bridge.broadcastEvent(event);
  logger.broadcastEvent(event);

  const request: HITLRequestEvent = {
    type: 'hitl_request', timestamp: new Date().toISOString(), id: `hitl_${crypto.randomUUID()}`,
    request_id: `req_${crypto.randomUUID()}`, agent_id: event.agent_id, incident_type: event.violation_type,
    context: { ...context, severity: event.severity, reporter_id: identity.id },
    action_options: ['allow_once', 'allow_session', 'deny_terminate'],
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
  bridge.broadcastEvent(request);
  logger.broadcastEvent(request);
  void notifier.notifyForDecision({ agent_id: event.agent_id, action: event.violation_type, request_id: request.request_id, status: 'pending_hitl', expires_at: request.expires_at, score: event.severity === 'critical' ? 95 : event.severity === 'high' ? 70 : event.severity === 'medium' ? 50 : 20, rules: [], requires_hitl: true }).catch(error => logger.error('[MCP] Notifier failed', { error: String(error) }));
  const decision = await hitlHandler.handleRequest(request, false);
  auditAnchor.record('mcp_agent_intervention_decision', {
    request_id: request.request_id, agent_id: event.agent_id, action: decision.action,
    reporter_id: identity.id, operator_id: decision.actor_id ?? 'timeout', reason: decision.reason,
  });
  return { request_id: request.request_id, agent_id: event.agent_id, decision: decision.action, reason: decision.reason };
}

async function guardAndSendSolana(input: Record<string, unknown>, identity: NonNullable<Request['asguardIdentity']>) {
  const solanaAdapter = chainRegistry.resolve('solana', 'devnet');
  if (!('simulateSignedTransaction' in solanaAdapter) || !('sendSignedTransaction' in solanaAdapter)) {
    throw new Error('Solana execution is disabled; register an optional Solana adapter explicitly.');
  }
  const stringFields = ['idempotency_key', 'agent_id', 'agent_name', 'wallet_id', 'action', 'transaction_base64'];
  if (stringFields.some((field) => typeof input[field] !== 'string' || !(input[field] as string).trim())) {
    throw new Error(`Required string fields: ${stringFields.join(', ')}.`);
  }
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotency_key as string)) {
    throw new Error('idempotency_key must be 8–128 characters using letters, numbers, dot, underscore, colon, or dash.');
  }
  if (!['low', 'medium', 'high'].includes(String(input.risk_level)) || typeof input.amount_usd !== 'number' || !Number.isFinite(input.amount_usd) || input.amount_usd < 0) {
    throw new Error('risk_level must be low, medium, or high and amount_usd must be a non-negative finite number.');
  }
  const transactionBase64 = input.transaction_base64 as string;
  const payloadHash = crypto.createHash('sha256').update(transactionBase64, 'utf8').digest('hex');
  let intent = createTransactionIntent({
    idempotency_key: input.idempotency_key as string,
    correlation_id: crypto.randomUUID(),
    agent_id: input.agent_id as string,
    wallet_id: input.wallet_id as string,
    network: `${solanaAdapter.chain}:${solanaAdapter.network}`,
    chain: solanaAdapter.chain,
    action: input.action as string,
    resource: typeof input.contract_address === 'string' ? input.contract_address : 'solana-transaction',
    payload_hash: payloadHash,
    amount: input.amount_usd,
    policy_version: policyStore.getPolicy().version,
    risk_level: input.risk_level as 'low' | 'medium' | 'high',
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  });
  if (intent.agent_id !== input.agent_id || intent.wallet_id !== input.wallet_id || intent.network !== `${solanaAdapter.chain}:${solanaAdapter.network}` || intent.payload_hash !== payloadHash) {
    throw new Error('idempotency_key is already bound to a different agent, wallet, network, or transaction payload.');
  }
  if (intent.status !== 'created') return { intent, duplicate: true, submitted: intent.status === 'submitted' || intent.status === 'confirmed' };
  intent = transitionTransactionIntent(intent.id, 'evaluating');

  const event: AgentActivityEvent = {
    type: 'agent_activity', timestamp: new Date().toISOString(), id: `evt_${crypto.randomUUID()}`,
    agent_id: intent.agent_id, agent_name: input.agent_name as string, action: intent.action,
    risk_level: input.risk_level as AgentActivityEvent['risk_level'], chain: intent.chain, network: solanaAdapter.network, details: { chain: intent.chain, network: solanaAdapter.network, wallet_id: intent.wallet_id, intent_id: intent.id, payload_hash: payloadHash },
  };
  auditAnchor.record('guarded_transaction_requested', {
    intent_id: intent.id, agent_id: intent.agent_id, wallet_id: intent.wallet_id,
    network: intent.network, payload_hash: payloadHash, actor_id: identity.id,
  });
  const policy = policyStore.getPolicy();
  const anomaly = await anomalyEngine.processActivity(event, {
    amount_usd: input.amount_usd,
    ip_address: input.ip_address as string | undefined,
    device_id: input.device_id as string | undefined,
    contract_address: input.contract_address as string | undefined,
  }, policy);
  bridge.broadcastEvent(event);
  logger.broadcastEvent(event);
  if (anomaly.anomaly_event) {
    bridge.broadcastEvent(anomaly.anomaly_event);
    logger.broadcastEvent(anomaly.anomaly_event);
  }

  const simulation = await solanaAdapter.simulateSignedTransaction(transactionBase64);
  intent = recordSimulation(intent.id, { status: simulation.err === null ? 'passed' : 'failed', details: simulation });
  if (simulation.err !== null) {
    auditAnchor.record('guarded_transaction_blocked', {
      intent_id: intent.id, reason: 'Solana simulation failed', simulation_error: simulation.err, actor_id: identity.id,
    });
    bridge.broadcastEvent({
      type: 'audit_log', timestamp: new Date().toISOString(), id: `evt_${crypto.randomUUID()}`,
      agent_id: intent.agent_id, action: 'Transaction blocked by Solana simulation', resource: intent.id,
      status: 'failure', details: { simulation_error: simulation.err },
    });
    return { intent, submitted: false, simulation, anomaly: anomaly.evaluation, blocked_reason: 'simulation_failed' };
  }

  const budgetExceeded = input.amount_usd > policy.max_auto_trade_usd;
  // Amounts and instruction semantics are supplied by the caller and are not yet
  // independently decoded/valued, so every submitted devnet transaction requires
  // explicit human approval even when the anomaly model reports a quiet pass.
  const requiresHuman = true;
  if (requiresHuman) {
    const request: HITLRequestEvent = {
      type: 'hitl_request', timestamp: new Date().toISOString(), id: `hitl_${crypto.randomUUID()}`,
      request_id: `req_${crypto.randomUUID()}`, agent_id: intent.agent_id,
      incident_type: budgetExceeded ? 'budget_overrun' : anomaly.evaluation.action,
      context: {
        intent_id: intent.id, chain: intent.network, action: intent.action, amount_usd: input.amount_usd,
        max_auto_trade_usd: policy.max_auto_trade_usd,
        declared_amount_is_independently_verified: false,
        budget_exceeded: budgetExceeded, anomaly: anomaly.evaluation,
        simulation: { err: simulation.err, logs: simulation.logs, units_consumed: simulation.unitsConsumed },
      },
      action_options: ['allow_once', 'allow_session', 'deny_terminate'],
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
    bridge.broadcastEvent(request);
    logger.broadcastEvent(request);
    void notifier.notifyForDecision({ agent_id: intent.agent_id, action: intent.action, amount_usd: input.amount_usd as number, request_id: request.request_id, status: 'pending_hitl', expires_at: request.expires_at, score: anomaly.evaluation.anomaly_score, rules: anomaly.evaluation.rules_triggered, requires_hitl: true }).catch(error => logger.error('[MCP] Notifier failed', { error: String(error) }));
    let decision;
    try {
      decision = await hitlHandler.handleRequest(request, false);
    } catch (error) {
      intent = transitionTransactionIntent(intent.id, 'rejected');
      return { intent, submitted: false, simulation, anomaly: anomaly.evaluation, blocked_reason: 'human_approval_unavailable', error: String(error) };
    }
    if (decision.action === 'deny_terminate') {
      intent = transitionTransactionIntent(intent.id, 'rejected');
      auditAnchor.record('guarded_transaction_rejected', { intent_id: intent.id, actor_id: identity.id, reason: decision.reason });
      return { intent, submitted: false, simulation, anomaly: anomaly.evaluation, blocked_reason: 'human_rejected' };
    }
    intent = transitionTransactionIntent(intent.id, 'approved');
    auditAnchor.record('guarded_transaction_approved', { intent_id: intent.id, actor_id: decision.actor_id ?? 'unknown-operator', decision: decision.action });
  } else {
    intent = transitionTransactionIntent(intent.id, 'approved');
  }

  intent = transitionTransactionIntent(intent.id, 'authorized');
  try {
    const signature = await solanaAdapter.sendSignedTransaction(transactionBase64);
    intent = transitionTransactionIntent(intent.id, 'submitted');
    auditAnchor.record('guarded_transaction_submitted', { intent_id: intent.id, signature, network: intent.network });
    bridge.broadcastEvent({
      type: 'audit_log', timestamp: new Date().toISOString(), id: `evt_${crypto.randomUUID()}`,
      agent_id: intent.agent_id, action: 'Guarded Solana transaction submitted', resource: intent.id,
      status: 'success', details: { signature, network: intent.network },
    });
    return { intent, submitted: true, signature, simulation, anomaly: anomaly.evaluation };
  } catch (error) {
    intent = transitionTransactionIntent(intent.id, 'failed');
    auditAnchor.record('guarded_transaction_submission_failed', { intent_id: intent.id, error: String(error) });
    throw error;
  }
}

app.post('/mcp', apiAuthenticator.authenticationMiddleware(), (req: Request, res: Response) => {
  handleMcpRequest(req, res, {
    getStatus: async () => ({
      runtime: runtimeName,
      daemon_connected: runtimeBridge.isConnected(),
      chain: await nearAdapter.health(),
      near: {
        rpc_url: nearAdapter.rpcUrl,
        intents_api_url: nearAdapter.intentsApiUrl,
        intents_verifier: nearAdapter.intentsVerifier,
        chain_signatures_contract: nearAdapter.chainSignaturesContract,
      },
    }),
    getPolicy: () => policyStore.getPolicy(),
    reportActivity: reportMcpActivity,
    reportViolation: reportMcpViolation,
    requestSignApproval: async (input, identity) => ({ ...await processSignApproval(input, identity, anomalyEngine, (event) => { bridge.broadcastEvent(event as Event); logger.broadcastEvent(event as Event); }) }),
    requestNearIntentApproval: async (input, identity) => ({ ...await processNearIntentApproval(input, identity, anomalyEngine, (event) => { bridge.broadcastEvent(event as Event); logger.broadcastEvent(event as Event); }) }),
    requestChainSignatureApproval: async (input, identity) => ({ ...await processChainSignatureApproval(input, identity, anomalyEngine, (event) => { bridge.broadcastEvent(event as Event); logger.broadcastEvent(event as Event); }) }),
    guardAndSendSolana,
    getTransactionStatus: getTransactionIntent,
    getApprovalStatus: getApprovalResult,
  });
});

app.post('/api/approvals/sign-request', apiAuthenticator.requireAnyRole('runtime', 'admin'), async (req: Request, res: Response) => {
  try {
    if (!req.asguardIdentity) { res.status(401).json({ status:'rejected', reason:'authentication_required' }); return; }
    const response = await processSignApproval(req.body as Record<string, unknown>, req.asguardIdentity, anomalyEngine, (event) => { bridge.broadcastEvent(event as Event); logger.broadcastEvent(event as Event); });
    res.status(response.status === 'rejected' ? 403 : 200).json(response);
  } catch (error) {
    res.status(400).json({ status:'rejected', reason:error instanceof Error ? error.message : 'invalid_request' });
  }
});

app.post('/api/approvals/near-intent', apiAuthenticator.requireAnyRole('runtime', 'admin'), async (req: Request, res: Response) => {
  try {
    if (!req.asguardIdentity) { res.status(401).json({ status:'rejected', reason:'authentication_required' }); return; }
    const response = await processNearIntentApproval(req.body as Record<string, unknown>, req.asguardIdentity, anomalyEngine, (event) => { bridge.broadcastEvent(event as Event); logger.broadcastEvent(event as Event); });
    res.status(response.status === 'rejected' ? 403 : 200).json(response);
  } catch (error) {
    res.status(400).json({ status:'rejected', reason:error instanceof Error ? error.message : 'invalid_request' });
  }
});

app.post('/api/approvals/chain-signature', apiAuthenticator.requireAnyRole('runtime', 'admin'), async (req: Request, res: Response) => {
  try {
    if (!req.asguardIdentity) { res.status(401).json({ status:'rejected', reason:'authentication_required' }); return; }
    const response = await processChainSignatureApproval(req.body as Record<string, unknown>, req.asguardIdentity, anomalyEngine, (event) => { bridge.broadcastEvent(event as Event); logger.broadcastEvent(event as Event); });
    res.status(response.status === 'rejected' ? 403 : 200).json(response);
  } catch (error) {
    res.status(400).json({ status:'rejected', reason:error instanceof Error ? error.message : 'invalid_request' });
  }
});

app.get('/api/approvals/:request_id', apiAuthenticator.requireAnyRole('runtime', 'admin', 'operator', 'auditor'), (req: Request, res: Response) => {
  const status = getApprovalResult(req.params.request_id);
  if (!status) { res.status(404).json({ status:'not_found', request_id:req.params.request_id }); return; }
  res.json(status);
});

// AgentSphere wallet authentication. Challenge responses are single-use and fail closed.
app.post('/api/auth/challenge', (req: Request, res: Response) => {
  try {
    const { wallet_address, origin } = req.body as { wallet_address?: string; origin?: string };
    res.json(createWalletChallenge(wallet_address ?? '', origin ?? ''));
  } catch (error) {
    res.status(400).json({ success: false, error: String(error) });
  }
});

app.post('/api/auth/verify', async (req: Request, res: Response) => {
  try {
    const operator = await verifyWalletChallenge(req.body);
    res.json({ success: true, operator });
  } catch (error) {
    res.status(401).json({ success: false, error: String(error) });
  }
});

app.post('/api/auth/ws-ticket', apiAuthenticator.requireAnyRole('admin', 'operator', 'auditor', 'runtime'), (req: Request, res: Response) => {
  try {
    if (!req.asguardIdentity) {
      res.status(401).json({ success: false, error: 'Authentication required.' });
      return;
    }
    res.json({ success: true, ticket: issueWebSocketTicket(req.asguardIdentity), expires_in_ms: 30_000 });
  } catch (error) {
    logger.error('[Server] WebSocket ticket issuance failed:', { error: String(error) });
    res.status(503).json({ success: false, error: 'WebSocket ticket service is unavailable.' });
  }
});

// Transaction intent lifecycle. Idempotency prevents duplicate execution requests.
app.get('/api/transactions', apiAuthenticator.requireAnyRole('admin', 'operator', 'auditor'), (_req: Request, res: Response) => res.json({ success: true, intents: listTransactionIntents() }));

app.post('/api/transactions', apiAuthenticator.requireAnyRole('runtime', 'admin'), (req: Request, res: Response) => {
  try {
    const intent = createTransactionIntent(req.body);
    res.status(201).json({ success: true, intent });
  } catch (error) {
    res.status(400).json({ success: false, error: String(error) });
  }
});

app.post('/api/transactions/:id/transition', apiAuthenticator.requireAnyRole('admin', 'operator'), (req: Request, res: Response) => {
  try {
    const { status } = req.body as { status?: string };
    if (status !== 'approved' && status !== 'rejected') {
      res.status(400).json({ success: false, error: 'Only approval or rejection is allowed on this endpoint.' });
      return;
    }
    const intent = transitionTransactionIntent(req.params.id, status);
    auditAnchor.record('transaction_approval', {
      intent_id: intent.id,
      decision: status,
      actor_id: req.asguardIdentity?.id,
      runtime: runtimeName,
    });
    res.json({ success: true, intent });
  } catch (error) {
    res.status(409).json({ success: false, error: String(error) });
  }
});

app.get('/api/transactions/:id', apiAuthenticator.requireAnyRole('admin', 'operator', 'auditor'), (req: Request, res: Response) => {
  const intent = getTransactionIntent(req.params.id);
  if (!intent) { res.status(404).json({ success: false, error: 'transaction intent not found' }); return; }
  res.json({ success: true, intent });
});

// Health check endpoint
app.get('/api/health', apiAuthenticator.requireAnyRole('admin', 'operator', 'auditor'), async (req: Request, res: Response) => {
  try {
    const blueprint = await unicityAdapter.buildBlueprint();
    const chain = await nearAdapter.health();
    const response: HealthCheckResponse & {
      runtimeConfig: typeof runtimeConfig;
      capsule: typeof capsuleConfig;
      providers: ReturnType<typeof providerRegistry.list>;
      unicity: Awaited<ReturnType<UnicityAdapter['buildBlueprint']>>;
      chain: Awaited<ReturnType<typeof nearAdapter.health>>;
      near: { rpc_url: string; intents_api_url: string; intents_verifier: string; chain_signatures_contract: string };
    } = {
      status: chain.healthy ? 'ok' : 'degraded',
      daemon_connected: runtimeBridge.isConnected(),
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      runtime: runtimeName,
      capabilities: capabilityManager.list(),
      runtimeConfig,
      capsule: capsuleConfig,
      providers: providerRegistry.list(),
      unicity: blueprint,
      chain,
      near: {
        rpc_url: nearAdapter.rpcUrl,
        intents_api_url: nearAdapter.intentsApiUrl,
        intents_verifier: nearAdapter.intentsVerifier,
        chain_signatures_contract: nearAdapter.chainSignaturesContract,
      },
    };
    res.json(response);
  } catch (error) {
    logger.error('[Server] Error building Unicity blueprint:', { error: String(error) });
    res.status(500).json({
      status: 'degraded',
      daemon_connected: runtimeBridge.isConnected(),
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      runtime: runtimeName,
      capabilities: capabilityManager.list(),
      error: String(error),
    });
  }
});

// Get current policy
app.get('/api/policy', apiAuthenticator.requireAnyRole('admin', 'operator', 'auditor'), (req: Request, res: Response) => {
  try {
    const policy = policyStore.getPolicy();
    const response: PolicyResponse = {
      success: true,
      policy,
    };
    res.json(response);
  } catch (error) {
    logger.error('[Server] Error getting policy:', {
      error: String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get policy',
    });
  }
});

// Update policy field
app.post('/api/policy', apiAuthenticator.requireAnyRole('admin'), (req: Request, res: Response) => {
  try {
    if (!capabilityManager.can('policy_management')) {
      res.status(403).json({
        success: false,
        error: 'Policy management capability is not authorized for this runtime',
      });
      return;
    }

    const { field, value } = req.body as PolicyUpdateRequest;

    if (!field || value === undefined) {
      res.status(400).json({
        success: false,
        error: 'Missing field or value',
      });
      return;
    }

    const oldValue = policyStore.getPolicy()[field];
    const updatedPolicy = policyStore.updateField(field, value);

    // Broadcast policy update event
    const event: Event = {
      type: 'policy_update',
      timestamp: new Date().toISOString(),
      id: `evt_${Date.now()}`,
      field,
      old_value: structuredClone(oldValue),
      new_value: value,
    };
    auditAnchor.record('policy_update', {
      field,
      value,
      runtime: runtimeName,
      actor_id: req.asguardIdentity?.id,
    });
    bridge.broadcastEvent(event);

    const response: PolicyResponse = {
      success: true,
      policy: updatedPolicy,
    };
    res.json(response);

    logger.info(`[Server] Policy updated via API: ${field} = ${JSON.stringify(value)}`);
  } catch (error) {
    logger.error('[Server] Error updating policy:', {
      error: String(error),
    });
    res.status(400).json({
      success: false,
      error: String(error),
    });
  }
});

// Reset policy to defaults
app.post('/api/policy/reset', apiAuthenticator.requireAnyRole('admin'), (req: Request, res: Response) => {
  try {
    const policy = policyStore.reset();
    auditAnchor.record('policy_reset', {
      runtime: runtimeName,
      actor_id: req.asguardIdentity?.id,
    });

    // Broadcast reset event
    const event: Event = {
      type: 'policy_update',
      timestamp: new Date().toISOString(),
      id: `evt_${Date.now()}`,
      field: 'all',
      old_value: null,
      new_value: 'defaults',
    };
    bridge.broadcastEvent(event);

    res.json({
      success: true,
      policy,
    });

    logger.info('[Server] Policy reset to defaults via API');
  } catch (error) {
    logger.error('[Server] Error resetting policy:', {
      error: String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to reset policy',
    });
  }
});

// Simulate agent activity (for testing)
app.post('/api/events/agent-activity', apiAuthenticator.requireAnyRole('runtime', 'admin'), async (req: Request, res: Response) => {
  try {
    const {
      agent_id,
      agent_name,
      action,
      risk_level,
      details,
      amount_usd,
      ip_address,
      device_id,
      contract_address,
      chain,
      network,
    } = req.body;

    if (!capabilityManager.can('event_monitoring')) {
      res.status(403).json({
        success: false,
        error: 'Event monitoring capability is not authorized for this runtime',
      });
      return;
    }

    const event: AgentActivityEvent = {
      type: 'agent_activity',
      timestamp: new Date().toISOString(),
      id: `evt_${Date.now()}`,
      agent_id,
      agent_name,
      action,
      risk_level,
      chain,
      network,
      details: details || {},
    };
    auditAnchor.record('agent_activity', {
      agent_id,
      action,
      risk_level,
      runtime: runtimeName,
      actor_id: req.asguardIdentity?.id,
    });

    // Get current policy
    const policy = policyStore.getPolicy();

    // Process through anomaly engine
    const anomalyResult = await anomalyEngine.processActivity(
      event,
      {
        amount_usd,
        ip_address,
        device_id,
        contract_address,
      },
      policy
    );

    // Broadcast original event
    bridge.broadcastEvent(event);
    logger.broadcastEvent(event);

    // Broadcast anomaly event if detected
    if (anomalyResult.anomaly_event) {
      bridge.broadcastEvent(anomalyResult.anomaly_event);
      logger.broadcastEvent(anomalyResult.anomaly_event);
    }

    // Trigger HITL if necessary
    if (anomalyResult.should_trigger_hitl) {
      const hitlEvent: HITLRequestEvent = {
        type: 'hitl_request',
        timestamp: new Date().toISOString(),
        id: `hitl_${Date.now()}`,
        request_id: `req_${Date.now()}`,
        agent_id,
        incident_type: 'anomaly_detected',
        context: {
          anomaly_score: anomalyResult.evaluation.anomaly_score,
          rules: anomalyResult.evaluation.rules_triggered,
          activity: event,
        },
        action_options: ['allow_once', 'allow_session', 'deny_terminate'],
        expires_at: new Date(Date.now() + 5 * 60000).toISOString(),
      };

      bridge.broadcastEvent(hitlEvent);
      void notifier.notifyForDecision({ agent_id, action: event.action, request_id: hitlEvent.request_id, status: 'pending_hitl', expires_at: hitlEvent.expires_at, score: anomalyResult.evaluation.anomaly_score, rules: anomalyResult.evaluation.rules_triggered, requires_hitl: true }).catch(error => logger.error('[Server] Notifier failed', { error: String(error) }));
      logger.broadcastEvent(hitlEvent);

      // Handle HITL in background
      hitlHandler
        .handleRequest(hitlEvent)
        .then((response) => {
          logger.info('[Server] HITL response received:', response as unknown as Record<string, unknown>);
          bridge.broadcastEvent({
            type: 'audit_log',
            timestamp: new Date().toISOString(),
            id: `evt_${Date.now()}`,
            agent_id,
            action: 'HITL Decision Applied',
            resource: hitlEvent.request_id,
            status: 'success',
            details: response as unknown as Record<string, unknown>,
          });
        });
    }

    res.json({
      success: true,
      event,
      anomaly: anomalyResult.evaluation,
      hitl_triggered: anomalyResult.should_trigger_hitl,
    });
  } catch (error) {
    logger.error('[Server] Error creating agent activity event:', {
      error: String(error),
    });
    res.status(400).json({
      success: false,
      error: String(error),
    });
  }
});

// Simulate security violation (for testing)
app.post('/api/events/security-violation', apiAuthenticator.requireAnyRole('runtime', 'admin'), (req: Request, res: Response) => {
  try {
    const {
      agent_id,
      violation_type,
      severity,
      requires_hitl,
      context,
    } = req.body;

    if (!capabilityManager.can('hitl_approval')) {
      res.status(403).json({
        success: false,
        error: 'HITL approval capability is not authorized for this runtime',
      });
      return;
    }

    const event: Event = {
      type: 'security_violation',
      timestamp: new Date().toISOString(),
      id: `evt_${Date.now()}`,
      agent_id,
      violation_type,
      severity,
      requires_hitl: requires_hitl || false,
      context: context || {},
    };
    auditAnchor.record('security_violation', {
      agent_id,
      violation_type,
      severity,
      runtime: runtimeName,
      actor_id: req.asguardIdentity?.id,
    });

    bridge.broadcastEvent(event);
    logger.broadcastEvent(event);

    // If HITL is required, spawn a request
    if (requires_hitl) {
      const hitlEvent: HITLRequestEvent = {
        type: 'hitl_request',
        timestamp: new Date().toISOString(),
        id: `evt_${Date.now()}`,
        request_id: `req_${Date.now()}`,
        agent_id,
        incident_type: violation_type,
        context,
        action_options: ['allow_once', 'allow_session', 'deny_terminate'],
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      };

      bridge.broadcastEvent(hitlEvent);
      if (requires_hitl) void notifier.notifyForDecision({ agent_id, action: violation_type, request_id: hitlEvent.request_id, status: 'pending_hitl', expires_at: hitlEvent.expires_at, score: severity === 'critical' ? 95 : severity === 'high' ? 70 : severity === 'medium' ? 50 : 20, rules: [], requires_hitl: true }).catch(error => logger.error('[Server] Notifier failed', { error: String(error) }));

      // Handle HITL in background
      hitlHandler
        .handleRequest(hitlEvent)
        .then((response) => {
          logger.info('[Server] HITL response received:', response as unknown as Record<string, unknown>);
          bridge.broadcastEvent({
            type: 'audit_log',
            timestamp: new Date().toISOString(),
            id: `evt_${Date.now()}`,
            agent_id,
            action: 'HITL Decision Applied',
            resource: hitlEvent.request_id,
            status: 'success',
            details: response as unknown as Record<string, unknown>,
          });
        })
        .catch((error) => {
          logger.error('[Server] HITL handler error:', { error: String(error) });
        });
    }

    res.json({ success: true, event });
  } catch (error) {
    logger.error('[Server] Error creating security violation event:', {
      error: String(error),
    });
    res.status(400).json({
      success: false,
      error: String(error),
    });
  }
});

// Get server stats
app.get('/api/stats', apiAuthenticator.requireAnyRole('admin', 'operator', 'auditor'), async (req: Request, res: Response) => {
  try {
    const blueprint = await unicityAdapter.buildBlueprint();
    const chain = await nearAdapter.health();
    res.json({
      connected_clients: bridge.getClientCount(),
      recent_events: bridge.getRecentEvents(10),
      uptime_ms: process.uptime() * 1000,
      capsule: capsuleConfig,
      providers: providerRegistry.list(),
      unicity: blueprint,
      chain,
      near: {
        rpc_url: nearAdapter.rpcUrl,
        intents_api_url: nearAdapter.intentsApiUrl,
        intents_verifier: nearAdapter.intentsVerifier,
        chain_signatures_contract: nearAdapter.chainSignaturesContract,
      },
    });
  } catch (error) {
    logger.error('[Server] Error building Unicity blueprint for stats:', { error: String(error) });
    res.status(500).json({
      connected_clients: bridge.getClientCount(),
      recent_events: bridge.getRecentEvents(10),
      uptime_ms: process.uptime() * 1000,
      capsule: capsuleConfig,
      providers: providerRegistry.list(),
      chain: await nearAdapter.health(),
      near: {
        rpc_url: nearAdapter.rpcUrl,
        intents_api_url: nearAdapter.intentsApiUrl,
        intents_verifier: nearAdapter.intentsVerifier,
        chain_signatures_contract: nearAdapter.chainSignaturesContract,
      },
      error: String(error),
    });
  }
});

// Phase 3: Anomaly engine endpoints

// Get anomaly engine diagnostics
app.get('/api/anomaly/diagnostics', apiAuthenticator.requireAnyRole('admin', 'operator', 'auditor'), (req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      diagnostics: anomalyEngine.getDiagnostics(),
      audit_chain_valid: anomalyEngine.verifyAuditChain(),
    });
  } catch (error) {
    logger.error('[Server] Error getting anomaly diagnostics:', {
      error: String(error),
    });
    res.status(500).json({
      success: false,
      error: String(error),
    });
  }
});

// Get agent anomaly profile
app.get('/api/anomaly/profile/:agent_id', apiAuthenticator.requireAnyRole('admin', 'operator', 'auditor'), (req: Request, res: Response) => {
  try {
    const { agent_id } = req.params;
    const profile = anomalyEngine.getAgentProfile(agent_id);
    res.json({
      success: true,
      agent_id,
      profile,
    });
  } catch (error) {
    logger.error('[Server] Error getting agent profile:', {
      error: String(error),
    });
    res.status(500).json({
      success: false,
      error: String(error),
    });
  }
});

// Reset agent profile
app.post('/api/anomaly/profile/:agent_id/reset', apiAuthenticator.requireAnyRole('admin'), (req: Request, res: Response) => {
  try {
    const { agent_id } = req.params;
    anomalyEngine.resetAgentProfile(agent_id);
    auditAnchor.record('agent_profile_reset', {
      agent_id,
      actor_id: req.asguardIdentity?.id,
      runtime: runtimeName,
    });
    
    // Broadcast event
    const event: Event = {
      type: 'audit_log',
      timestamp: new Date().toISOString(),
      id: `evt_${Date.now()}`,
      agent_id,
      action: 'Profile Reset',
      resource: agent_id,
      status: 'success',
    };
    bridge.broadcastEvent(event);
    logger.broadcastEvent(event);

    res.json({
      success: true,
      message: `Profile reset for ${agent_id}`,
    });
  } catch (error) {
    logger.error('[Server] Error resetting profile:', {
      error: String(error),
    });
    res.status(500).json({
      success: false,
      error: String(error),
    });
  }
});

// Export audit trail
app.get('/api/anomaly/audit-trail', apiAuthenticator.requireAnyRole('admin', 'operator', 'auditor'), (req: Request, res: Response) => {
  try {
    const auditTrail = anomalyEngine.exportAuditTrail();
    res.json({
      success: true,
      ...auditTrail,
    });
  } catch (error) {
    logger.error('[Server] Error exporting audit trail:', {
      error: String(error),
    });
    res.status(500).json({
      success: false,
      error: String(error),
    });
  }
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path,
  });
});

// Error handler
app.use((error: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error('[Server] Unhandled error:', { error: error.message });
  res.status(500).json({
    error: 'Internal server error',
  });
});

// Graceful shutdown
const shutdown = () => {
  logger.info('[Server] Shutting down gracefully...');
  hitlHandler.close();
  bridge.close();
  httpServer.close(() => {
    logger.info('[Server] Server closed');
    process.exit(0);
  });
};

// Human approval decisions can be made by an authenticated dashboard operator.
app.get('/api/hitl/pending', apiAuthenticator.requireAnyRole('admin', 'operator'), (_req: Request, res: Response) => {
  res.json({ success: true, requests: [...hitlHandler.getPendingRequests().values()].map(({ event }) => event) });
});

app.post('/api/hitl/:request_id/respond', apiAuthenticator.requireAnyRole('admin', 'operator'), (req: Request, res: Response) => {
  const { action, reason } = req.body as { action?: string; reason?: string };
  if (action !== 'allow_once' && action !== 'allow_session' && action !== 'deny_terminate') {
    res.status(400).json({ success: false, error: 'Invalid HITL action.' });
    return;
  }
  const decision = hitlHandler.respond({ request_id: req.params.request_id, action, reason: reason || 'Dashboard operator decision', actor_id: req.asguardIdentity?.id });
  if (!decision) {
    res.status(404).json({ success: false, error: 'Approval request is no longer pending.' });
    return;
  }
  auditAnchor.record('hitl_decision', {
    request_id: req.params.request_id, action, actor_id: req.asguardIdentity?.id, runtime: runtimeName,
  });
  bridge.broadcastEvent({
    type: 'audit_log', timestamp: new Date().toISOString(), id: `evt_${crypto.randomUUID()}`,
    agent_id: decision.agent_id, action: 'HITL Decision Applied', resource: req.params.request_id,
    status: action === 'deny_terminate' ? 'failure' : 'success', details: { action, actor_id: req.asguardIdentity?.id, reason },
  });
  res.json({ success: true, decision });
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
httpServer.listen(Number(PORT), HOST as string, () => {
  logger.success(
    `[Server] Asguard bridge listening on http://${HOST}:${PORT}`
  );
  logger.info(`[Server] WebSocket endpoint: ws://${HOST}:${PORT}/ws`);
  logger.info(
    `[Server] Policy file: ${policyStore.getPolicyPath()}`
  );

  // Broadcast connection status
  const connectionEvent: Event = {
    type: 'connection_status',
    timestamp: new Date().toISOString(),
    id: `evt_${Date.now()}`,
    status: 'connected',
    daemon: 'asguard-bridge',
  };
  bridge.broadcastEvent(connectionEvent);
});
