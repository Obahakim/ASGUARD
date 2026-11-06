export const TIDEPOOL_TESTNET_URL = 'https://www.usetidepool.tech';

export interface TidepoolToken {
  assetId: string;
  decimals: number;
  symbol: string;
  price?: number;
}

export interface TidepoolQuoteRequest {
  dry: false;
  swapType: 'EXACT_INPUT';
  slippageTolerance: number;
  originAsset: string;
  depositType: 'INTENTS';
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: 'INTENTS';
  recipient: string;
  recipientType: 'DESTINATION_CHAIN';
  deadline: string;
}

export interface TidepoolQuote {
  depositAddress: string;
  amountIn: string;
  amountInUsd: string;
  amountOut: string;
  minAmountOut: string;
  deadline: string;
}

export interface TidepoolQuoteResponse {
  correlationId: string;
  timestamp: string;
  signature: string;
  quoteRequest: TidepoolQuoteRequest;
  quote: TidepoolQuote;
}

export interface TidepoolGeneratedIntent {
  intent: { standard: 'raw_ed25519'; payload: string };
  correlationId: string;
}

export interface TidepoolStatus {
  status: 'KNOWN_DEPOSIT_TX' | 'PENDING_DEPOSIT' | 'INCOMPLETE_DEPOSIT' | 'PROCESSING' | 'SUCCESS' | 'REFUNDED' | 'FAILED';
  quoteResponse?: TidepoolQuoteResponse;
  updatedAt?: string;
  swapDetails?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface TidepoolClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class TidepoolApiError extends Error {
  constructor(message: string, readonly status: number, readonly pathname: string) {
    super(message);
    this.name = 'TidepoolApiError';
  }
}

export class TidepoolClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: TidepoolClientOptions = {}) {
    const baseUrl = options.baseUrl ?? TIDEPOOL_TESTNET_URL;
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw new Error('Tidepool URL must be a valid HTTPS URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('Tidepool API must use HTTPS and cannot include credentials, query, or hash.');
    }
    this.baseUrl = url.toString().replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60_000) throw new Error('Tidepool timeout must be from 100 to 60000 milliseconds.');
  }

  private async request<T>(pathname: string, init?: RequestInit): Promise<T> {
    const url = new URL(pathname, `${this.baseUrl}/`);
    if (url.protocol !== 'https:' || url.origin !== new URL(this.baseUrl).origin) throw new Error('Tidepool request URL escaped the configured HTTPS origin.');
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(this.timeoutMs),
        headers: { 'content-type': 'application/json', ...init?.headers },
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new Error('Tidepool request timed out. Check Tidepool health and retry.');
      throw new Error('Tidepool is unreachable. Check https://www.usetidepool.tech/v0/health and retry.');
    }
    const body = await response.json().catch(() => undefined) as unknown;
    if (!response.ok) {
      const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
      const message = typeof record.message === 'string' ? record.message : typeof record.error === 'string' ? record.error : `HTTP ${response.status}`;
      throw new TidepoolApiError(`Tidepool ${pathname} failed (${message}).`, response.status, pathname);
    }
    if (body === undefined) throw new Error(`Tidepool ${pathname} returned invalid JSON.`);
    return body as T;
  }

  async health(): Promise<{ service: string; network: string; verifier: string; ok?: boolean }> {
    return this.request('/v0/health');
  }

  async listTokens(): Promise<TidepoolToken[]> {
    const tokens = await this.request<unknown>('/v0/tokens');
    if (!Array.isArray(tokens) || tokens.some((token) => typeof token !== 'object' || token === null || typeof (token as { assetId?: unknown }).assetId !== 'string')) {
      throw new Error('Tidepool /v0/tokens returned an unsupported token list.');
    }
    return tokens as TidepoolToken[];
  }

  async getQuote(request: TidepoolQuoteRequest): Promise<TidepoolQuoteResponse> {
    const quote = await this.request<TidepoolQuoteResponse>('/v0/quote', { method: 'POST', body: JSON.stringify(request) });
    if (!quote.correlationId || !quote.signature || !quote.quote?.depositAddress || !quote.quote.amountIn || !quote.quote.minAmountOut || !quote.quote.deadline) {
      throw new Error('Tidepool /v0/quote omitted required signed quote fields.');
    }
    const requestFields = Object.keys(request) as Array<keyof TidepoolQuoteRequest>;
    if (requestFields.some((field) => quote.quoteRequest?.[field] !== request[field]) || quote.quote.amountIn !== request.amount) {
      throw new Error('Tidepool quote does not match the requested assets, amount, recipient, or deposit terms.');
    }
    return quote;
  }

  async generateIntent(input: { signerId: string; depositAddress: string }): Promise<TidepoolGeneratedIntent> {
    const value = await this.request<TidepoolGeneratedIntent>('/v0/generate-intent', {
      method: 'POST', body: JSON.stringify({ type: 'swap_transfer', standard: 'raw_ed25519', ...input }),
    });
    if (value.intent?.standard !== 'raw_ed25519' || typeof value.intent.payload !== 'string' || !value.correlationId) {
      throw new Error('Tidepool /v0/generate-intent returned an unsupported signing payload.');
    }
    return value;
  }

  async submitIntent(signedData: { standard: 'raw_ed25519'; payload: string; public_key: string; signature: string }): Promise<Record<string, unknown>> {
    return this.request('/v0/submit-intent', { method: 'POST', body: JSON.stringify({ type: 'swap_transfer', signedData }) });
  }

  async getStatus(depositAddress: string): Promise<TidepoolStatus> {
    const query = new URLSearchParams({ depositAddress });
    return this.request(`/v0/status?${query}`);
  }

  async requestFaucet(input: { accountId: string; mode: 'wallet' | 'intents'; assets?: string[] }): Promise<Record<string, unknown>> {
    return this.request('/v0/faucet', { method: 'POST', body: JSON.stringify(input) });
  }

  async waitForFinalStatus(depositAddress: string, options: { timeoutMs?: number; pollIntervalMs?: number } = {}): Promise<TidepoolStatus> {
    const deadline = Date.now() + (options.timeoutMs ?? 180_000);
    const pollIntervalMs = options.pollIntervalMs ?? 3_000;
    while (Date.now() < deadline) {
      const status = await this.getStatus(depositAddress);
      if (['SUCCESS', 'REFUNDED', 'FAILED'].includes(status.status)) return status;
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, deadline - Date.now())));
    }
    throw new Error('Tidepool swap did not reach a final status before the demo timeout.');
  }
}

export function buildTidepoolNearIntent(quoteResponse: TidepoolQuoteResponse, generated: TidepoolGeneratedIntent, verifier: string): Record<string, unknown> {
  const request = quoteResponse.quoteRequest;
  const quote = quoteResponse.quote;
  const amountUsd = Number(quote.amountInUsd);
  if (!Number.isFinite(amountUsd) || amountUsd < 0) throw new Error('Tidepool quote contains an invalid USD amount.');
  return {
    intent_type: 'swap',
    origin_asset: request.originAsset,
    destination_asset: request.destinationAsset,
    amount: quote.amountIn,
    min_output_amount: quote.minAmountOut,
    recipient: request.recipient,
    destination_chain: 'near',
    deadline: quote.deadline,
    max_slippage_bps: request.slippageTolerance,
    amount_usd: amountUsd,
    quote_id: quoteResponse.correlationId,
    extensions: {
      tidepool: {
        verifier,
        correlationId: quoteResponse.correlationId,
        quoteRequest: quoteResponse.quoteRequest,
        quote: quoteResponse.quote,
        quoteSignature: quoteResponse.signature,
        generatedIntent: generated.intent,
      },
    },
  };
}

export function assertGeneratedSwapTransfer(
  quoteResponse: TidepoolQuoteResponse,
  generated: TidepoolGeneratedIntent,
  signerId: string,
  verifier: string,
  now = Date.now(),
): true {
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(generated.intent.payload) as Record<string, unknown>; }
  catch { throw new Error('Tidepool generated an invalid NEAR Intents transfer payload.'); }
  const intents = payload.intents;
  const transfer = Array.isArray(intents) && intents.length === 1 && typeof intents[0] === 'object' && intents[0] !== null
    ? intents[0] as Record<string, unknown> : undefined;
  const tokens = transfer?.tokens;
  const deadline = typeof payload.deadline === 'string' ? Date.parse(payload.deadline) : Number.NaN;
  const nonce = typeof payload.nonce === 'string' ? Buffer.from(payload.nonce, 'base64') : Buffer.alloc(0);
  const expectedAmount = quoteResponse.quote.amountIn;
  if (generated.intent.standard !== 'raw_ed25519'
    || payload.signer_id !== signerId
    || payload.verifying_contract !== verifier
    || !Number.isFinite(deadline) || deadline <= now
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(String(payload.nonce ?? '')) || nonce.length !== 32
    || transfer?.intent !== 'transfer'
    || transfer.receiver_id !== quoteResponse.quote.depositAddress
    || typeof tokens !== 'object' || tokens === null || Array.isArray(tokens)
    || Object.keys(tokens).length !== 1
    || (tokens as Record<string, unknown>)[quoteResponse.quoteRequest.originAsset] !== expectedAmount
    || verifier !== 'verifier.tidepool-sandbox.testnet') {
    throw new Error('Tidepool generated a transfer that does not match the approved quote, signer, and verifier.');
  }
  return true;
}
