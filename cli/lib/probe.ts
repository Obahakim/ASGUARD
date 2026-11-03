export type FetchImplementation = typeof fetch;

export async function probeRpc(url: string, fetchImpl: FetchImplementation = fetch): Promise<string> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'asguard-setup', method: 'status', params: [] }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const result = await response.json() as { result?: { sync_info?: { latest_block_height?: number } } };
  const height = result.result?.sync_info?.latest_block_height;
  return typeof height === 'number' ? `block ${height}` : 'reachable';
}

export async function probeReachability(url: string, fetchImpl: FetchImplementation = fetch): Promise<void> {
  await fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
}

export async function probeNearAi(options: {
  endpoint: string;
  model: string;
  apiKey: string;
  fetchImpl?: FetchImplementation;
}): Promise<{ ok: boolean; status?: number; reason?: string }> {
  try {
    const response = await (options.fetchImpl ?? fetch)(options.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: 'Return exactly {"summary":"ok","signals":[]} as JSON.' }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { ok: false, status: response.status, reason: 'Check the endpoint, model, and API key.' };
    const result = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = result.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return { ok: false, status: response.status, reason: 'The provider returned no JSON message content.' };
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { return { ok: false, status: response.status, reason: 'The provider response was not valid JSON.' }; }
    return {
      ok: Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed)),
      status: response.status,
      reason: 'The provider response was not a JSON object.',
    };
  } catch (error) {
    const reason = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
      ? 'Request timed out.' : 'Could not reach the provider.';
    return { ok: false, reason };
  }
}
