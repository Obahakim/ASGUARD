# ASGUARD

ASGUARD is an AgentSphere security and control-plane prototype.

## Pilot readiness

ASGUARD is currently a local security-control prototype. The end-to-end AgentSphere transaction pilot is being built fail-closed: unavailable Unicity services make live validation unavailable rather than fabricating success. Configure `UNICITY_NETWORK`, `UNICITY_WALLET_API_URL`, and `UNICITY_DEVICE_ID` only through the runtime environment; AgentSphere uses wallet signatures rather than a separate Oracle API key. Never commit wallet material.

Current pilot status:
- Implemented: typed transaction intent and approval domain, runtime artifact protection, environment-based Unicity configuration.
- Requires configured services: live AgentSphere wallet authentication, validation, simulation, submission, and finality.
- Local fallback only: existing JSON policy/audit stores and demo dashboard fixtures.
- Not production-ready: mainnet operation, multisig governance, externally anchored audit evidence, complete daemon integration, and independent security review.

## Next Steps

1. Implement AgentSphere wallet challenge/signature verification for REST and WebSocket operators.
2. Persist transaction intents, approvals, incidents, and audit records in Neon.
3. Connect the transaction-intent state machine to Astrid execution and fail closed on unavailable validation.
4. Add live Unicity validation, simulation, submission, and finality tracking.
5. Replace demo dashboard data with authenticated API and WebSocket state.
6. Add adversarial tests, CI secret scanning, monitoring, multisig administration, and an independent security review before mainnet.

## Template Audit Results

This repository is a pilot scaffold, not a security certification. Do not treat its current local stores, dashboard fixtures, or adapter status as evidence of mainnet readiness.

---
