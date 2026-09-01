/**
 * Asguard Backend Server
 * Main entry point - initializes HTTP/WebSocket server and REST API
 */

import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import { WebSocketBridge } from './bridge';
import { policyStore } from './policyStore';
import { logger } from './logger';
import { hitlHandler } from './hitlHandler';
import AnomalyEngine from './anomalyEngine';
import AuditChain from './auditChain';
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

// Configuration
const PORT = process.env.ASGUARD_PORT || 8080;
const HOST = process.env.ASGUARD_HOST || 'localhost';
const runtimeName = process.env.ASGUARD_RUNTIME || 'astrid';
process.env.ASGUARD_RUNTIME = runtimeName;

const capabilityManager = new CapabilityManager(defaultCapabilities);
capabilityManager.grant('audit_anchoring');
runtimeBridge.connect();
const unicityAdapter = new UnicityAdapter();

// Initialize Express app
const app = express();
const httpServer = http.createServer(app);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Initialize WebSocket bridge
const bridge = new WebSocketBridge(httpServer, PORT as number);
logger.setBridge(bridge);

// Initialize anomaly engine (Phase 3)
const anomalyEngine = new AnomalyEngine();

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

// Health check endpoint
app.get('/api/health', async (req: Request, res: Response) => {
  try {
    const blueprint = await unicityAdapter.buildBlueprint();
    const response: HealthCheckResponse & {
      runtimeConfig: typeof runtimeConfig;
      capsule: typeof capsuleConfig;
      providers: ReturnType<typeof providerRegistry.list>;
      unicity: Awaited<ReturnType<UnicityAdapter['buildBlueprint']>>;
    } = {
      status: 'ok',
      daemon_connected: runtimeBridge.isConnected(),
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      runtime: runtimeName,
      capabilities: capabilityManager.list(),
      runtimeConfig,
      capsule: capsuleConfig,
      providers: providerRegistry.list(),
      unicity: blueprint,
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
app.get('/api/policy', (req: Request, res: Response) => {
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
app.post('/api/policy', (req: Request, res: Response) => {
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

    const updatedPolicy = policyStore.updateField(field, value);

    // Broadcast policy update event
    const event: Event = {
      type: 'policy_update',
      timestamp: new Date().toISOString(),
      id: `evt_${Date.now()}`,
      field,
      old_value: null, // TODO: Track old value in policyStore
      new_value: value,
    };
    auditAnchor.record('policy_update', { field, value, runtime: runtimeName });
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
app.post('/api/policy/reset', (req: Request, res: Response) => {
  try {
    const policy = policyStore.reset();

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
app.post('/api/events/agent-activity', async (req: Request, res: Response) => {
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
      details: details || {},
    };
    auditAnchor.record('agent_activity', { agent_id, action, risk_level, runtime: runtimeName });

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
app.post('/api/events/security-violation', (req: Request, res: Response) => {
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
    auditAnchor.record('security_violation', { agent_id, violation_type, severity, runtime: runtimeName });

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
app.get('/api/stats', async (req: Request, res: Response) => {
  try {
    const blueprint = await unicityAdapter.buildBlueprint();
    res.json({
      connected_clients: bridge.getClientCount(),
      recent_events: bridge.getRecentEvents(10),
      uptime_ms: process.uptime() * 1000,
      capsule: capsuleConfig,
      providers: providerRegistry.list(),
      unicity: blueprint,
    });
  } catch (error) {
    logger.error('[Server] Error building Unicity blueprint for stats:', { error: String(error) });
    res.status(500).json({
      connected_clients: bridge.getClientCount(),
      recent_events: bridge.getRecentEvents(10),
      uptime_ms: process.uptime() * 1000,
      capsule: capsuleConfig,
      providers: providerRegistry.list(),
      error: String(error),
    });
  }
});

// Phase 3: Anomaly engine endpoints

// Get anomaly engine diagnostics
app.get('/api/anomaly/diagnostics', (req: Request, res: Response) => {
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
app.get('/api/anomaly/profile/:agent_id', (req: Request, res: Response) => {
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
app.post('/api/anomaly/profile/:agent_id/reset', (req: Request, res: Response) => {
  try {
    const { agent_id } = req.params;
    anomalyEngine.resetAgentProfile(agent_id);
    
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
app.get('/api/anomaly/audit-trail', (req: Request, res: Response) => {
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
