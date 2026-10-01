# ASGUARD Production Readiness Roadmap

## Current status
- In progress: trusted runtime integration
- Implemented: named API identities and route-level roles; startup validation for API and audit signing keys; audit-chain integrity checks on load and atomic fail-closed writes
- Still required before deployment: signed runtime events, authenticated WebSocket clients, durable database-backed state, and validation on Node.js 22+

## API credential configuration
Set `ASGUARD_API_CREDENTIALS` to a JSON array of identities. Each identity needs a unique id, a unique randomly generated token of at least 32 bytes, and one or more roles (`admin`, `operator`, `auditor`, `runtime`). Inject this value through the deployment secret manager; do not commit credentials to the repository.

Example shape, with placeholders only:
```json
[
	{ "id": "runtime-prod", "token": "<runtime-secret>", "roles": ["runtime"] },
	{ "id": "ops-admin", "token": "<operator-secret>", "roles": ["admin", "operator", "auditor"] }
]
```

## Phase 0: Security baseline
- Require explicit runtime secrets (`ASGUARD_API_CREDENTIALS`, `ASGUARD_AUDIT_KEY`)
- Fail closed if config is missing
- Protect all sensitive API routes behind auth
- Remove hardcoded defaults and unsafe fallbacks

## Phase 1: Trusted execution model
- Add signed authenticated service identity for runtime bridge
- Validate signed event payloads from agent runtimes
- Enforce role-based access for policy updates and approvals
- Add per-request audit metadata (actor, reason, timestamp)
- Authenticate and authorize WebSocket clients

## Phase 2: Durable state and replay
- Move policy, profile, and approval data to Postgres
- Store audit logs in append-only records with hash chaining
- Add data retention, backup, and restore workflows
- Add migration tooling and schema versioning

## Phase 3: Detection hardening
- Replace heuristics with time-windowed historical baselines
- Add false-positive tuning and explainability for every alert
- Add suppression / exception workflows for legitimate activity
- Add SLOs for detection precision and latency

## Phase 4: Operational resilience
- Add rate limiting, retries, and dead-letter queues
- Add metrics, tracing, and alerting
- Add health checks for dependencies and runtime status
- Add deployment configs for staging and production

## Phase 5: UX and operating model
- Build a live dashboard backed by real backend state
- Add approval queue and operator workflows
- Add incident investigation tooling
- Add release gating and rollback process

## Phase 6: Production launch
- Security review and penetration test
- Chaos / failure testing
- Playbook and runbook review
- Production deployment with monitoring and on-call rotation
