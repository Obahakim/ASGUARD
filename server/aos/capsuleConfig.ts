import manifest from './manifest.json';

export interface CapsuleManifest {
  name: string;
  displayName: string;
  type: string;
  version: string;
  description: string;
  capabilities: string[];
  runtime: {
    engine: string;
    bridge: string;
  };
}

export const capsuleConfig = manifest as CapsuleManifest;
