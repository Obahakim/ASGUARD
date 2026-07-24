import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderRegistry } from './providerRegistry';

test('registers and resolves AOS-compatible providers', () => {
  const registry = new ProviderRegistry();
  const providers = registry.list();

  assert.ok(providers.some((provider) => provider.id === 'ollama'));
  assert.ok(providers.some((provider) => provider.id === 'claude'));
  assert.ok(providers.some((provider) => provider.id === 'groq'));

  const selected = registry.resolve('claude');
  assert.equal(selected?.id, 'claude');
});

test('registers a custom provider adapter', async () => {
  const registry = new ProviderRegistry();
  const adapter = {
    id: 'custom-adapter',
    name: 'Custom Adapter',
    kind: 'adapter' as const,
    description: 'Custom adapter for local experiments',
    capabilities: ['audit_anchoring'],
    health: async () => ({ status: 'ok' as const, detail: 'ready' }),
  };

  registry.register(adapter);
  const selected = registry.resolve('custom-adapter');

  assert.ok(selected);
  assert.equal(selected?.name, 'Custom Adapter');
  assert.equal(selected?.capabilities?.[0], 'audit_anchoring');

  const health = await registry.health('custom-adapter');
  assert.equal(health?.status, 'ok');
});
