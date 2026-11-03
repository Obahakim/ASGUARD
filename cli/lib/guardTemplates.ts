export type GuardLanguage = 'ts' | 'js';
export type SdkImportChoice = 'relative' | 'package';
export type ModuleFormat = 'esm' | 'cjs';

function importSpecifier(choice: SdkImportChoice, relativeSpecifier: string): string {
  return choice === 'package' ? 'asguard/agent-sdk' : relativeSpecifier;
}

export function buildGuardTemplate(
  language: GuardLanguage,
  choice: SdkImportChoice,
  relativeSpecifier: string,
  moduleFormat: ModuleFormat = 'esm',
): string {
  const specifier = JSON.stringify(importSpecifier(choice, relativeSpecifier));
  if (language === 'js' && moduleFormat === 'cjs') return `const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const sdkModule = import(${specifier});

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error('Missing required ASGUARD environment variable: ' + name);
  return value.trim();
}
function config() {
  return {
    baseUrl: required('ASGUARD_API_URL'),
    token: required('ASGUARD_RUNTIME_TOKEN'),
    agentId: required('ASGUARD_AGENT_ID'),
    agentName: required('ASGUARD_AGENT_NAME'),
    network: required('ASGUARD_NETWORK'),
    attestationPublicKey: fs.readFileSync(required('ASGUARD_ATTESTATION_PUBLIC_KEY_PATH'), 'utf8')
  };
}
let initialized;
function initAsguard() {
  if (!initialized) {
    initialized = (async () => {
      const values = config();
      const sdk = await sdkModule;
      const accountIds = required('ASGUARD_AGENT_ACCOUNT_IDS').split(',').map((id) => id.trim()).filter(Boolean);
      return sdk.connectAgent({ baseUrl: values.baseUrl, token: values.token, agentId: values.agentId, agentName: values.agentName, network: values.network, accountIds });
    })();
  }
  return initialized;
}
function approvalOptions(values, payload, payloadDomain, riskLevel, extra) {
  return {
    baseUrl: values.baseUrl, token: values.token, attestationPublicKey: values.attestationPublicKey,
    agentId: values.agentId, agentName: values.agentName, payload, payloadDomain,
    network: values.network, idempotencyKey: randomUUID(), riskLevel, timeoutMs: 180000, ...extra
  };
}
async function guardedTransfer(transfer, signAndSubmit, riskLevel = 'high') {
  const sdk = await sdkModule;
  const values = config();
  return sdk.withAsguardApproval(approvalOptions(values, transfer, 'near-transfer', riskLevel, {}), async ({ attestation, canonicalPayload, decision }) => signAndSubmit({ attestation, canonicalPayload, decision }));
}
async function guardedIntent(intent, options, signAndSubmit) {
  const sdk = await sdkModule;
  const values = config();
  return sdk.withAsguardApproval(approvalOptions(values, intent, 'near-intent', options.riskLevel, {
    expectedVerifier: options.expectedVerifier, expectedMaxAmountUsd: options.expectedMaxAmountUsd
  }), async ({ attestation, canonicalPayload, decision }) => signAndSubmit({ attestation, canonicalPayload, decision }));
}
async function guardedChainSignature(payload, options, requestSignature) {
  const sdk = await sdkModule;
  const values = config();
  return sdk.withAsguardApproval(approvalOptions(values, payload, 'near-chain-signature', options.riskLevel, {
    chain: options.chain, derivationPath: options.derivationPath, signerContract: options.signerContract
  }), async ({ attestation, canonicalPayload, decision }) => requestSignature({ attestation, canonicalPayload, decision }));
}
exports.initAsguard = initAsguard;
exports.guardedTransfer = guardedTransfer;
exports.guardedIntent = guardedIntent;
exports.guardedChainSignature = guardedChainSignature;
`;
  if (language === 'js') return `import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { connectAgent, withAsguardApproval } from ${specifier};

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error('Missing required ASGUARD environment variable: ' + name);
  return value.trim();
}
function config() {
  return {
    baseUrl: required('ASGUARD_API_URL'),
    token: required('ASGUARD_RUNTIME_TOKEN'),
    agentId: required('ASGUARD_AGENT_ID'),
    agentName: required('ASGUARD_AGENT_NAME'),
    network: required('ASGUARD_NETWORK'),
    attestationPublicKey: fs.readFileSync(required('ASGUARD_ATTESTATION_PUBLIC_KEY_PATH'), 'utf8')
  };
}
let initialized;
export function initAsguard() {
  if (!initialized) {
    const values = config();
    const accountIds = required('ASGUARD_AGENT_ACCOUNT_IDS').split(',').map((id) => id.trim()).filter(Boolean);
    initialized = connectAgent({ baseUrl: values.baseUrl, token: values.token, agentId: values.agentId, agentName: values.agentName, network: values.network, accountIds });
  }
  return initialized;
}
function approvalOptions(values, payload, payloadDomain, riskLevel, extra) {
  return {
    baseUrl: values.baseUrl, token: values.token, attestationPublicKey: values.attestationPublicKey,
    agentId: values.agentId, agentName: values.agentName, payload, payloadDomain,
    network: values.network, idempotencyKey: randomUUID(), riskLevel, timeoutMs: 180000, ...extra
  };
}
export function guardedTransfer(transfer, signAndSubmit, riskLevel = 'high') {
  const values = config();
  return withAsguardApproval(approvalOptions(values, transfer, 'near-transfer', riskLevel, {}), async ({ attestation, canonicalPayload, decision }) => signAndSubmit({ attestation, canonicalPayload, decision }));
}
export function guardedIntent(intent, options, signAndSubmit) {
  const values = config();
  return withAsguardApproval(approvalOptions(values, intent, 'near-intent', options.riskLevel, {
    expectedVerifier: options.expectedVerifier, expectedMaxAmountUsd: options.expectedMaxAmountUsd
  }), async ({ attestation, canonicalPayload, decision }) => signAndSubmit({ attestation, canonicalPayload, decision }));
}
export function guardedChainSignature(payload, options, requestSignature) {
  const values = config();
  return withAsguardApproval(approvalOptions(values, payload, 'near-chain-signature', options.riskLevel, {
    chain: options.chain, derivationPath: options.derivationPath, signerContract: options.signerContract
  }), async ({ attestation, canonicalPayload, decision }) => requestSignature({ attestation, canonicalPayload, decision }));
}
`;

  return `import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { connectAgent, withAsguardApproval } from ${specifier};
import type { AsguardApprovalContext, AsguardRiskLevel } from ${specifier};

type ApprovalCallback<TResult> = (context: AsguardApprovalContext<unknown>) => Promise<TResult> | TResult;
type GuardOptions = { riskLevel: AsguardRiskLevel };
type IntentGuardOptions = GuardOptions & { expectedVerifier: string; expectedMaxAmountUsd: number };
type ChainSignatureGuardOptions = GuardOptions & { chain: string; derivationPath: string; signerContract: string };

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error('Missing required ASGUARD environment variable: ' + name);
  return value.trim();
}
function config() {
  return {
    baseUrl: required('ASGUARD_API_URL'),
    token: required('ASGUARD_RUNTIME_TOKEN'),
    agentId: required('ASGUARD_AGENT_ID'),
    agentName: required('ASGUARD_AGENT_NAME'),
    network: required('ASGUARD_NETWORK'),
    attestationPublicKey: fs.readFileSync(required('ASGUARD_ATTESTATION_PUBLIC_KEY_PATH'), 'utf8'),
  };
}
let initialized: ReturnType<typeof connectAgent> | undefined;
export function initAsguard(): ReturnType<typeof connectAgent> {
  if (!initialized) {
    const values = config();
    const accountIds = required('ASGUARD_AGENT_ACCOUNT_IDS').split(',').map((id) => id.trim()).filter(Boolean);
    initialized = connectAgent({
      baseUrl: values.baseUrl, token: values.token, agentId: values.agentId,
      agentName: values.agentName, network: values.network as 'near:mainnet' | 'near:testnet', accountIds,
    });
  }
  return initialized;
}
function approvalOptions<TPayload>(
  values: ReturnType<typeof config>,
  payload: TPayload,
  payloadDomain: 'near-transfer' | 'near-intent' | 'near-chain-signature',
  riskLevel: AsguardRiskLevel,
  extra: Record<string, unknown>,
) {
  return {
    baseUrl: values.baseUrl, token: values.token, attestationPublicKey: values.attestationPublicKey,
    agentId: values.agentId, agentName: values.agentName, payload, payloadDomain,
    network: values.network, idempotencyKey: randomUUID(), riskLevel, timeoutMs: 180_000, ...extra,
  };
}
export function guardedTransfer<TPayload, TResult>(
  transfer: TPayload,
  signAndSubmit: ApprovalCallback<TResult>,
  riskLevel: AsguardRiskLevel = 'high',
): Promise<TResult> {
  const values = config();
  return withAsguardApproval(approvalOptions(values, transfer, 'near-transfer', riskLevel, {}), async ({ attestation, canonicalPayload, decision }) =>
    signAndSubmit({ attestation, canonicalPayload, decision }));
}
export function guardedIntent<TPayload, TResult>(
  intent: TPayload,
  options: IntentGuardOptions,
  signAndSubmit: ApprovalCallback<TResult>,
): Promise<TResult> {
  const values = config();
  return withAsguardApproval(approvalOptions(values, intent, 'near-intent', options.riskLevel, {
    expectedVerifier: options.expectedVerifier, expectedMaxAmountUsd: options.expectedMaxAmountUsd,
  }), async ({ attestation, canonicalPayload, decision }) => signAndSubmit({ attestation, canonicalPayload, decision }));
}
export function guardedChainSignature<TPayload, TResult>(
  payload: TPayload,
  options: ChainSignatureGuardOptions,
  requestSignature: ApprovalCallback<TResult>,
): Promise<TResult> {
  const values = config();
  return withAsguardApproval(approvalOptions(values, payload, 'near-chain-signature', options.riskLevel, {
    chain: options.chain, derivationPath: options.derivationPath, signerContract: options.signerContract,
  }), async ({ attestation, canonicalPayload, decision }) => requestSignature({ attestation, canonicalPayload, decision }));
}
`;
}
