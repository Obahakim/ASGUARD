export const HTTP_LOOPBACK_HOSTNAMES: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

export function isHttpLoopbackUrl(url: URL): boolean {
  return url.protocol === 'http:' && HTTP_LOOPBACK_HOSTNAMES.includes(url.hostname);
}

export function isAllowedApiEndpoint(url: URL): boolean {
  return url.protocol === 'https:' || isHttpLoopbackUrl(url);
}
