export function getAuditSigningKey(value = process.env.ASGUARD_AUDIT_KEY): string {
  const signingKey = value?.trim();
  if (!signingKey) {
    throw new Error('ASGUARD_AUDIT_KEY must be configured in the environment before starting the backend.');
  }

  if (Buffer.byteLength(signingKey, 'utf8') < 32) {
    throw new Error('ASGUARD_AUDIT_KEY must contain at least 32 bytes.');
  }

  return signingKey;
}