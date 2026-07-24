export type CapabilityName =
  | 'policy_management'
  | 'event_monitoring'
  | 'hitl_approval'
  | 'audit_anchoring';

export interface CapabilityCheckOptions {
  requireRuntime?: boolean;
}

export class CapabilityManager {
  private granted = new Set<CapabilityName>();

  constructor(initial?: CapabilityName[]) {
    const capabilities = initial ?? defaultCapabilities;
    capabilities.forEach((cap) => this.granted.add(cap));
  }

  grant(capability: CapabilityName): void {
    this.granted.add(capability);
  }

  revoke(capability: CapabilityName): void {
    this.granted.delete(capability);
  }

  has(capability: CapabilityName): boolean {
    return this.granted.has(capability);
  }

  can(capability: CapabilityName, options: CapabilityCheckOptions = {}): boolean {
    if (!this.granted.has(capability)) {
      return false;
    }

    if (options.requireRuntime) {
      return process.env.ASGUARD_RUNTIME === 'astrid';
    }

    return true;
  }

  list(): CapabilityName[] {
    return Array.from(this.granted);
  }
}

export const defaultCapabilities: CapabilityName[] = [
  'policy_management',
  'event_monitoring',
  'hitl_approval',
];
