import type { Request, Response } from 'express';
import type { ApiIdentity } from './auth';
import type { AsguardPolicy } from './types';

export interface McpServices {
  getStatus(): Promise<Record<string, unknown>>;
  getPolicy(): AsguardPolicy;
  reportActivity(input: Record<string, unknown>, identity: ApiIdentity): Promise<Record<string, unknown>>;
  reportViolation(input: Record<string, unknown>, identity: ApiIdentity): Promise<Record<string, unknown>>;
  guardAndSendSolana(input: Record<string, unknown>, identity: ApiIdentity): Promise<Record<string, unknown>>;
  requestSignApproval(input: Record<string, unknown>, identity: ApiIdentity): Promise<Record<string, unknown>>;
  requestNearIntentApproval(input: Record<string, unknown>, identity: ApiIdentity): Promise<Record<string, unknown>>;
  requestChainSignatureApproval(input: Record<string, unknown>, identity: ApiIdentity): Promise<Record<string, unknown>>;
  getTransactionStatus(id: string): unknown;
  getApprovalStatus(id: string): unknown;
}

type McpRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
const PROTOCOL_VERSION = '2025-03-26';

const tools = [
  {
    name: 'asguard_get_status',
    description: 'Read ASGUARD runtime and configured chain health.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'asguard_get_policy',
    description: 'Read the active ASGUARD safety policy before proposing an agent action.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'asguard_request_sign_approval',
    description: 'Create a network-agnostic signing approval request and return an ASGUARD attestation only on approval.',
    inputSchema: {
      type: 'object',
      required: ['agent_id', 'agent_name', 'action', 'risk_level', 'payload_hash', 'network', 'idempotency_key'],
      properties: {
        agent_id: { type: 'string', minLength: 1, maxLength: 128 },
        agent_name: { type: 'string', minLength: 1, maxLength: 128 },
        action: { type: 'string', minLength: 1, maxLength: 512 },
        risk_level: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        payload_hash: { type: 'string', minLength: 1, maxLength: 256 },
        payload_domain: { type: 'string', maxLength: 128 },
        derivation_path: { type: 'string', maxLength: 128 },
        intent_type: { type: 'string', maxLength: 64 },
        network: { type: 'string', minLength: 1, maxLength: 128 },
        chain: { type: 'string', minLength: 1, maxLength: 64 },
        amount_usd: { type: 'number', minimum: 0 },
        ip_address: { type: 'string' },
        device_id: { type: 'string' },
        contract_address: { type: 'string' },
        wallet_id: { type: 'string' },
        idempotency_key: { type: 'string', minLength: 8, maxLength: 128 },
        details: { type: 'object' },
        simulation: { type: 'object' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'asguard_request_near_intent_approval',
    description: 'Evaluate a canonical NEAR Intent against policy and anomaly rules; return a short-lived attestation, pending human approval, or a denial. ASGUARD never signs or submits the intent.',
    inputSchema: {
      type: 'object',
      required: ['agent_id', 'agent_name', 'risk_level', 'idempotency_key', 'near_intent'],
      properties: {
        agent_id: { type: 'string', minLength: 1, maxLength: 128 },
        agent_name: { type: 'string', minLength: 1, maxLength: 128 },
        risk_level: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        idempotency_key: { type: 'string', minLength: 8, maxLength: 128 },
        near_intent: {
          type: 'object',
          properties: {
            standard: { type: 'string', maxLength: 32 },
            payload: { type: 'object' },
            intent_type: { type: 'string', minLength: 1, maxLength: 64 },
            origin_asset: { type: 'string', minLength: 1, maxLength: 256 },
            destination_asset: { type: 'string', minLength: 1, maxLength: 256 },
            amount: { type: 'string', pattern: '^[0-9]+$' },
            min_output_amount: { type: 'string', pattern: '^[0-9]+$' },
            recipient: { type: 'string', maxLength: 256 },
            destination_chain: { type: 'string', maxLength: 64 },
            deadline: { type: 'string', format: 'date-time' },
            max_slippage_bps: { type: 'integer', minimum: 0, maximum: 10000 },
            amount_usd: { type: 'number', minimum: 0 },
            quote_id: { type: 'string', maxLength: 256 },
            extensions: { type: 'object' },
          },
          anyOf: [
            { required: ['intent_type', 'origin_asset', 'destination_asset', 'amount'] },
            { required: ['standard', 'payload'] },
          ],
          additionalProperties: false,
        },
        ip_address: { type: 'string' },
        device_id: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'asguard_request_chain_signature_approval',
    description: 'Evaluate a foreign-chain payload before its host requests a NEAR Chain Signature; the attestation binds payload hash, target network, and derivation path. ASGUARD never requests the MPC signature.',
    inputSchema: {
      type: 'object',
      required: ['agent_id', 'agent_name', 'action', 'risk_level', 'payload_hash', 'network', 'chain', 'derivation_path', 'idempotency_key'],
      properties: {
        agent_id: { type: 'string', minLength: 1, maxLength: 128 },
        agent_name: { type: 'string', minLength: 1, maxLength: 128 },
        action: { type: 'string', minLength: 1, maxLength: 512 },
        risk_level: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        payload_hash: { type: 'string', pattern: '^[A-Fa-f0-9]{64}$' },
        network: { type: 'string', minLength: 1, maxLength: 128 },
        chain: { type: 'string', minLength: 1, maxLength: 64 },
        derivation_path: { type: 'string', minLength: 1, maxLength: 128 },
        amount_usd: { type: 'number', minimum: 0 },
        wallet_id: { type: 'string', maxLength: 128 },
        ip_address: { type: 'string' },
        device_id: { type: 'string' },
        idempotency_key: { type: 'string', minLength: 8, maxLength: 128 },
        details: { type: 'object' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'asguard_get_approval_status',
    description: 'Check whether a pending sign approval has been approved or rejected, and retrieve its attestation after human approval.',
    inputSchema: { type: 'object', required: ['request_id'], properties: { request_id: { type: 'string', minLength: 1, maxLength: 128 } }, additionalProperties: false },
  },
  {
    name: 'asguard_get_transaction_status',
    description: 'Read the current state of a previously submitted or blocked ASGUARD transaction intent.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 128 } }, additionalProperties: false },
  },
  {
    name: 'asguard_report_activity',
    description: 'Submit observed agent activity to the existing anomaly rules, audit chain, and human approval workflow.',
    inputSchema: {
      type: 'object',
      required: ['agent_id', 'agent_name', 'action', 'risk_level'],
      properties: {
        agent_id: { type: 'string', minLength: 1, maxLength: 128 },
        agent_name: { type: 'string', minLength: 1, maxLength: 128 },
        action: { type: 'string', minLength: 1, maxLength: 512 },
        risk_level: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        details: { type: 'object' },
        chain: { type: 'string' },
        network: { type: 'string' },
        amount_usd: { type: 'number', minimum: 0 },
        ip_address: { type: 'string' },
        device_id: { type: 'string' },
        contract_address: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'asguard_guarded_solana_send',
    description: 'Optional legacy Solana devnet compatibility flow. Disabled unless ASGUARD_ENABLE_SOLANA_ADAPTER=true; use NEAR Intent approval by default.',
    inputSchema: {
      type: 'object',
      required: ['idempotency_key', 'agent_id', 'agent_name', 'wallet_id', 'action', 'risk_level', 'amount_usd', 'transaction_base64'],
      properties: {
        idempotency_key: { type: 'string', minLength: 8, maxLength: 128 },
        agent_id: { type: 'string', minLength: 1, maxLength: 128 },
        agent_name: { type: 'string', minLength: 1, maxLength: 128 },
        wallet_id: { type: 'string', minLength: 1, maxLength: 128 },
        action: { type: 'string', minLength: 1, maxLength: 512 },
        risk_level: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        amount_usd: { type: 'number', minimum: 0 },
        transaction_base64: { type: 'string', minLength: 1, maxLength: 1500000 },
        ip_address: { type: 'string' },
        device_id: { type: 'string' },
        contract_address: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'asguard_report_security_violation',
    description: 'Report a suspected compromised or unsafe agent and wait for an authenticated human decision.',
    inputSchema: {
      type: 'object', required: ['agent_id', 'violation_type', 'severity'],
      properties: {
        agent_id: { type: 'string', minLength: 1, maxLength: 128 },
        violation_type: { type: 'string', minLength: 1, maxLength: 256 },
        severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        context: { type: 'object' },
      }, additionalProperties: false,
    },
  },
];

function response(id: McpRequest['id'], result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id: McpRequest['id'], code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export function handleMcpRequest(req: Request, res: Response, services: McpServices): void {
  const message = req.body as McpRequest;
  const id = message?.id;
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    res.status(400).json(errorResponse(id, -32600, 'Invalid JSON-RPC request.'));
    return;
  }

  if (message.method.startsWith('notifications/')) {
    res.sendStatus(202);
    return;
  }
  if (id === undefined) {
    res.status(400).json(errorResponse(null, -32600, 'A JSON-RPC request ID is required.'));
    return;
  }

  void (async () => {
    try {
      if (message.method === 'initialize') {
        res.json(response(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'asguard', version: '1.0.0' },
        }));
      } else if (message.method === 'ping') {
        res.json(response(id, {}));
      } else if (message.method === 'tools/list') {
        res.json(response(id, { tools }));
      } else if (message.method === 'tools/call') {
        const params = message.params ?? {};
        const name = params.name;
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        let value: unknown;
        if (name === 'asguard_get_status') {
          value = await services.getStatus();
        } else if (name === 'asguard_get_policy') {
          if (!req.asguardIdentity?.roles.some((role) => ['admin', 'operator', 'auditor'].includes(role))) {
            res.status(403).json(errorResponse(id, -32003, 'Insufficient role to read policy.'));
            return;
          }
          value = services.getPolicy();
        } else if (name === 'asguard_request_sign_approval') {
          if (!req.asguardIdentity?.roles.some((role) => ['runtime', 'admin'].includes(role))) {
            res.status(403).json(errorResponse(id, -32003, 'Insufficient role to request sign approval.'));
            return;
          }
          value = await services.requestSignApproval(args, req.asguardIdentity);
        } else if (name === 'asguard_request_near_intent_approval') {
          if (!req.asguardIdentity?.roles.some((role) => ['runtime', 'admin'].includes(role))) {
            res.status(403).json(errorResponse(id, -32003, 'Insufficient role to request NEAR Intent approval.'));
            return;
          }
          value = await services.requestNearIntentApproval(args, req.asguardIdentity);
        } else if (name === 'asguard_request_chain_signature_approval') {
          if (!req.asguardIdentity?.roles.some((role) => ['runtime', 'admin'].includes(role))) {
            res.status(403).json(errorResponse(id, -32003, 'Insufficient role to request Chain Signatures approval.'));
            return;
          }
          value = await services.requestChainSignatureApproval(args, req.asguardIdentity);
        } else if (name === 'asguard_get_transaction_status') {
          if (!req.asguardIdentity?.roles.some((role) => ['runtime', 'admin', 'operator', 'auditor'].includes(role))) {
            res.status(403).json(errorResponse(id, -32003, 'Insufficient role to read transaction status.'));
            return;
          }
          const transactionId = args.id;
          if (typeof transactionId !== 'string') {
            res.status(400).json(errorResponse(id, -32602, 'id is required.'));
            return;
          }
          value = services.getTransactionStatus(transactionId) ?? { found: false };
        } else if (name === 'asguard_get_approval_status') {
          if (!req.asguardIdentity?.roles.some((role) => ['runtime', 'admin', 'operator', 'auditor'].includes(role))) {
            res.status(403).json(errorResponse(id, -32003, 'Insufficient role to read approval status.'));
            return;
          }
          if (typeof args.request_id !== 'string') { res.status(400).json(errorResponse(id, -32602, 'request_id is required.')); return; }
          value = services.getApprovalStatus(args.request_id) ?? { found: false };
        } else if (name === 'asguard_report_activity') {
          if (!req.asguardIdentity?.roles.some((role) => ['runtime', 'admin'].includes(role))) {
            res.status(403).json(errorResponse(id, -32003, 'Insufficient role to report runtime activity.'));
            return;
          }
          value = await services.reportActivity(args, req.asguardIdentity);
        } else if (name === 'asguard_report_security_violation') {
          if (!req.asguardIdentity?.roles.some((role) => ['runtime', 'admin'].includes(role))) {
            res.status(403).json(errorResponse(id, -32003, 'Insufficient role to report a runtime security violation.'));
            return;
          }
          value = await services.reportViolation(args, req.asguardIdentity);
        } else if (name === 'asguard_guarded_solana_send') {
          if (!req.asguardIdentity?.roles.some((role) => ['runtime', 'admin'].includes(role))) {
            res.status(403).json(errorResponse(id, -32003, 'Insufficient role to request a guarded transaction.'));
            return;
          }
          value = await services.guardAndSendSolana(args, req.asguardIdentity);
        } else {
          res.status(400).json(errorResponse(id, -32602, 'Unknown ASGUARD tool.'));
          return;
        }
        res.json(response(id, { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }));
      } else {
        res.status(400).json(errorResponse(id, -32601, 'Method not found.'));
      }
    } catch (error) {
      res.json(response(id, {
        content: [{ type: 'text', text: error instanceof Error ? error.message : 'ASGUARD operation failed.' }],
        isError: true,
      }));
    }
  })();
}

const mcp = { handleMcpRequest };

export default mcp;
