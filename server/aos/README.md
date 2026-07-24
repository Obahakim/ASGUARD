# AOS runtime integration

This folder contains the AOS-oriented runtime scaffolding for ASGUARD.

## Components
- capabilityManager.ts: runtime capability gating for policy, event, HITL, and audit actions.
- runtimeBridge.ts: lightweight runtime bridge abstraction for daemon connectivity.
- runtimeConfig.ts: shared runtime configuration surfaced to the backend.
- providerRegistry.ts: registry for local, remote, and adapter-backed providers.
- unicityAdapter.ts: adapter that builds a Unicity/Sphere runtime blueprint for the backend.

## Integration notes
- The backend health and stats endpoints now expose runtimeConfig, capsule metadata, provider definitions, and the current Unicity blueprint.
- Provider adapters can be registered at runtime via the provider registry and can optionally expose a health probe.
