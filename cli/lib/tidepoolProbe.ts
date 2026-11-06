import { nearIntentsDefaults } from '../../server/aos/nearIntentsConfig';
import { TidepoolClient } from '../../scripts/tidepool-client';

export async function probeTidepool(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 4_000,
): Promise<{ available: boolean; reason?: string }> {
  try {
    const health = await new TidepoolClient({ fetchImpl, timeoutMs }).health();
    if (!health || typeof health !== 'object'
      || typeof health.network !== 'string' || typeof health.verifier !== 'string') {
      return { available: false, reason: 'invalid health response' };
    }
    if (health.network !== 'testnet') return { available: false, reason: 'service is not on testnet' };
    if (health.verifier !== nearIntentsDefaults('testnet', true).verifier) {
      return { available: false, reason: 'service verifier does not match testnet defaults' };
    }
    return { available: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const status = message.match(/HTTP (\d{3})/i)?.[1];
    if (status) return { available: false, reason: `HTTP ${status}` };
    if (/timeout|timed out|abort/i.test(message)) return { available: false, reason: 'request timed out' };
    return { available: false, reason: 'could not reach the service' };
  }
}
