# ASGUARD runtime integration

This folder contains generic runtime helpers used by the NEAR-native ASGUARD control plane.

- `capabilityManager.ts` gates policy, event, HITL, and audit actions.
- `runtimeBridge.ts` provides the local runtime connection abstraction.
- `runtimeConfig.ts` exposes the configured ASGUARD runtime name and supported capabilities.
- `providerRegistry.ts` manages providers used by active ASGUARD integrations.

Health and stats report runtime configuration, registered providers, NEAR RPC health, and configured NEAR Intents and Chain Signatures endpoints.
