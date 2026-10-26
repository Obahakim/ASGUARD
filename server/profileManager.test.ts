import test from 'node:test';
import assert from 'node:assert/strict';

import type { AgentActivityEvent } from './types';
import { ProfileManager } from './profileManager';
import type { PersistedAgentProfile, ProfilePersistence } from './profileStore';

class MemoryProfilePersistence implements ProfilePersistence {
  profiles: PersistedAgentProfile[] = [];

  load(): PersistedAgentProfile[] {
    return structuredClone(this.profiles);
  }

  save(profiles: PersistedAgentProfile[]): void {
    this.profiles = structuredClone(profiles);
  }
}

test('agent behavior profiles survive reload and reset through pluggable persistence', () => {
  const persistence = new MemoryProfilePersistence();
  const manager = new ProfileManager(persistence);
  const activity: AgentActivityEvent = {
    type: 'agent_activity',
    id: 'event-1',
    timestamp: new Date().toISOString(),
    agent_id: 'near-agent',
    agent_name: 'NEAR Agent',
    action: 'swap',
    risk_level: 'low',
    details: {},
    chain: 'near',
    network: 'testnet',
  };

  for (let index = 0; index < 5; index += 1) {
    manager.updateProfile({ ...activity, id: `event-${index}` }, {
      amount_usd: 10,
      ip_address: '192.0.2.1',
      device_id: 'device-a',
    });
  }

  const reloaded = new ProfileManager(persistence);
  const profile = reloaded.getBaselineStats('near-agent');
  assert.equal(profile.observations, 5);
  assert.equal(profile.mature, true);
  assert.deepEqual(profile.known_ips, ['192.0.2.1']);
  assert.deepEqual(profile.known_devices, ['device-a']);
  assert.deepEqual(profile.known_chains, ['near:testnet']);

  reloaded.resetProfile('near-agent');
  assert.equal(new ProfileManager(persistence).getBaselineStats('near-agent').observations, 0);
});