# ASGUARD

ASGUARD is a second pair of eyes for agents that move value. It does not hold private keys or replace the trading engine. Instead, it evaluates proposed actions before signing and blocks or escalates when policy or anomaly rules are violated.

## What ASGUARD is and is not

ASGUARD is:
- a pre-sign approval layer for runtime agents and hosts
- a policy and anomaly evaluator
- an audit chain and human-in-the-loop gate
- a notifier for high-severity events

ASGUARD is not:
- a key custodian
- a wallet signer
- a replacement for local trading logic
- a place to store or log raw secrets, seed phrases, or private keys

## Architecture

Agent -> request approval -> attestation -> local signer -> chain

The preferred flow is:
1. runtime prepares a signed payload hash or canonical intent bytes
2. ASGUARD evaluates risk and policy
3. ASGUARD returns either: approved + short-lived attestation, pending HITL approval, or rejected / blocked
4. host verifies the attestation locally and only then signs in-process

## MCP tools

Key tools:
- asguard_request_sign_approval
- asguard_report_activity
- asguard_get_policy
- asguard_get_status
- asguard_guarded_solana_send (compatibility wrapper)
- asguard_report_security_violation

## Pre-sign approval model

ASGUARD accepts a network-agnostic approval request with:
- agent_id
- agent_name
- action
- risk_level
- payload_hash
- network
- amount_usd
- ip_address
- device_id
- contract_address
- wallet_id
- idempotency_key
- details

A valid approval returns a short-lived attestation signed with the ASGUARD audit HMAC key. The host must verify:
- the signature is valid
- the attestation is not expired
- sha256(bytesToSign) matches payload_hash
- agent_id and amount bounds are acceptable
- the action matches the requested intent

The helper `assertApprovedThenSign` is the host-side reference verifier.

## Environment variables

Required or recommended:
- ASGUARD_API_CREDENTIALS: JSON array of runtime/admin credentials
- ASGUARD_AUDIT_KEY: shared signing key used for attestation generation and audit integrity
- ASGUARD_APPROVAL_TTL_MS: approval expiry in milliseconds; default 120000
- ASGUARD_PORT / ASGUARD_HOST
- ASGUARD_ALLOWED_ORIGINS
- TELEGRAM_WEBHOOK_URL / SLACK_WEBHOOK_URL / DISCORD_WEBHOOK_URL / ASGUARD_GENERIC_WEBHOOK_URL

## Quickstart

1. Configure ASGUARD_API_CREDENTIALS.
2. Set ASGUARD_AUDIT_KEY to a strong shared secret.
3. Start the backend.
4. Use the MCP approval request or REST endpoint.
5. Verify the attestation locally before signing.

## Threat badge legend and notifications

- LOW (0-39): dashboard digest only
- ELEVATED (40-69): Telegram/Slack/webhook notification with dedupe
- HIGH (70-89): push + channel notification; action required
- CRITICAL (90-100): multi-channel repeated notifications until resolved or expired

Timeouts default to deny. High-risk requests without human resolution remain blocked.

## Integration guidance for agents

Only expose signed, gated tools to your agents. Never expose raw sign/send methods directly. The host should verify the ASGUARD attestation before invoking the wallet or chain adapter.

## Security summary

ASGUARD never stores raw signing secrets. It issues short-lived attestations that permit local signing only after verification of the exact payload.
