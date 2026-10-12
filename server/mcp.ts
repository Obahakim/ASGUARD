import type { Request, Response } from 'express';
import type { ApiIdentity } from './auth';
import type { AsguardPolicy } from './types';

export interface McpServices {
  getStatus(): Promise<Record<string, unknown>>;
  getPolicy(): AsguardPolicy;
  reportActivity(input: Record<string, unknown>, identity: ApiIdentity): Promise<Record<string, unknown>>;
  reportViolation(input: Record<string, unknown>, identity: ApiIdentity): Promise<Record<string, unknown>>;
  guardAndSendSolana(input: Record<string, unknown>, identity: ApiIdentity): Promise<Record<string, unknown>>;
  getTransactionStatus(id: string): unknown;
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
        risk_level: { type: 'string', enum: ['low', 'medium', 'high'] },
        details: { type: 'object' },
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
    description: 'Evaluate a signed Solana devnet transaction against ASGUARD policy, simulate it, request a human decision when risk is detected, then submit only after approval.',
    inputSchema: {
      type: 'object',
      required: ['idempotency_key', 'agent_id', 'agent_name', 'wallet_id', 'action', 'risk_level', 'amount_usd', 'transaction_base64'],
      properties: {
        idempotency_key: { type: 'string', minLength: 8, maxLength: 128 },
        agent_id: { type: 'string', minLength: 1, maxLength: 128 },
        agent_name: { type: 'string', minLength: 1, maxLength: 128 },
        wallet_id: { type: 'string', minLength: 1, maxLength: 128 },
        action: { type: 'string', minLength: 1, maxLength: 512 },
        risk_level: { type: 'string', enum: ['low', 'medium', 'high'] },
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
