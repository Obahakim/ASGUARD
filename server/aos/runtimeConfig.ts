export interface RuntimeConfig {
  runtimeName: string;
  bridgeType: 'http' | 'ws' | 'local';
  capabilities: string[];
}

export const runtimeConfig: RuntimeConfig = {
  runtimeName: process.env.ASGUARD_RUNTIME || 'astrid',
  bridgeType: 'http',
  capabilities: ['policy_management', 'event_monitoring', 'hitl_approval', 'audit_anchoring'],
};
