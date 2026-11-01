export function getAuditSigningKey(value = process.env.ASGUARD_AUDIT_KEY): string {
  const signingKey = value?.trim();
  if (!signingKey) {
    throw new Error('ASGUARD_AUDIT_KEY is missing. Set it in .env to a random value of at least 32 bytes before starting the backend.');
  }

  if (Buffer.byteLength(signingKey, 'utf8') < 32) {
    throw new Error('ASGUARD_AUDIT_KEY must contain at least 32 bytes. Generate a random value, set it in .env, and restart the backend.');
  }

  return signingKey;
}