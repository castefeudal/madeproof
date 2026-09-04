import dns from 'node:dns';
import net from 'node:net';
import { MadeProofError } from '../../shared/src/errors.js';

function isPrivateIp(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const normalized = address.toLowerCase();
  return (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:') ||
    normalized.startsWith('::ffff:127.')
  );
}

export async function validateExternalUrl(
  raw: string,
  options: { allowLocal?: boolean } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MadeProofError('INVALID_URL', 'URL is invalid', 422);
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new MadeProofError('URL_SCHEME_FORBIDDEN', 'Only HTTP and HTTPS URLs are allowed', 422);
  if (url.username || url.password)
    throw new MadeProofError(
      'URL_CREDENTIALS_FORBIDDEN',
      'Credentials in URLs are not allowed',
      422,
    );
  if (options.allowLocal && ['localhost', '127.0.0.1', '::1'].includes(url.hostname)) return url;
  const results = await dns.promises.lookup(url.hostname, { all: true, verbatim: true });
  if (!results.length)
    throw new MadeProofError('DNS_RESOLUTION_FAILED', 'URL hostname did not resolve', 422);
  if (results.some((result: any) => isPrivateIp(result.address))) {
    throw new MadeProofError(
      'SSRF_BLOCKED',
      'Private, loopback, link-local and metadata network targets are blocked',
      403,
    );
  }
  return url;
}
