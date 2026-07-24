export interface ProviderHealth {
  status: 'ok' | 'degraded' | 'error';
  detail?: string;
}

export interface ProviderAdapter extends ProviderDefinition {
  capabilities?: string[];
  health?: () => Promise<ProviderHealth>;
}

export interface ProviderDefinition {
  id: string;
  name: string;
  kind: 'local' | 'remote' | 'adapter';
  description: string;
  capabilities?: string[];
}

export class ProviderRegistry {
  private providers: ProviderAdapter[] = [
    {
      id: 'ollama',
      name: 'Ollama',
      kind: 'local',
      description: 'Local provider for AOS-compatible runtime execution',
    },
    {
      id: 'claude',
      name: 'Claude',
      kind: 'remote',
      description: 'Remote provider via hosted agent adapter',
    },
    {
      id: 'groq',
      name: 'Groq',
      kind: 'adapter',
      description: 'Adapter-based provider for high-throughput inference',
    },
  ];

  register(provider: ProviderAdapter): void {
    this.providers.push(provider);
  }

  list(): ProviderDefinition[] {
    return this.providers.map((provider) => ({ ...provider }));
  }

  resolve(id: string): ProviderDefinition | undefined {
    return this.providers.find((provider) => provider.id === id);
  }

  async health(id: string): Promise<ProviderHealth | undefined> {
    const provider = this.providers.find((candidate) => candidate.id === id);
    if (!provider?.health) {
      return { status: 'ok', detail: 'no health probe configured' };
    }

    return provider.health();
  }
}

export const providerRegistry = new ProviderRegistry();
