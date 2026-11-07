export function parseNearFunctionCallStringResult(result: unknown): string {
  if (!Array.isArray(result) || result.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error('NEAR testnet USDC balance response was invalid.');
  }

  const encodedValue = Buffer.from(result).toString('utf8').trim();
  let value = encodedValue;
  if (encodedValue.startsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(encodedValue);
      if (typeof decoded !== 'string') throw new Error();
      value = decoded;
    } catch {
      throw new Error('NEAR testnet USDC balance response was invalid.');
    }
  }

  if (!/^\d+$/.test(value)) throw new Error('NEAR testnet USDC balance response was invalid.');
  return value;
}
