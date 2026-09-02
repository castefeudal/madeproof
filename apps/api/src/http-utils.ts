import fs from 'node:fs';
import path from 'node:path';
import { MadeProofError } from '../../../packages/shared/src/errors.js';

export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

export async function readJson(request: any, maxBytes = 1024 * 1024): Promise<any> {
  const chunks: any[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes)
      throw new MadeProofError('PAYLOAD_TOO_LARGE', 'Request body exceeds 1 MiB', 413);
    chunks.push(chunk);
  }
  if (!bytes) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new MadeProofError('INVALID_JSON', 'Request body must be valid JSON', 400);
  }
}

export function sendJson(
  response: any,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
}

export function sendText(
  response: any,
  status: number,
  body: string,
  contentType = 'text/plain; charset=utf-8',
): void {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

export function serveStatic(
  response: any,
  root: string,
  requestPath: string,
  fallback = 'index.html',
): boolean {
  const normalized = requestPath === '/' ? fallback : requestPath.replace(/^\/+/, '');
  let target = path.resolve(root, normalized);
  const safeRoot = path.resolve(root);
  if (!target.startsWith(`${safeRoot}${path.sep}`) && target !== safeRoot) return false;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory())
    target = path.resolve(root, fallback);
  if (
    !target.startsWith(`${safeRoot}${path.sep}`) ||
    !fs.existsSync(target) ||
    !fs.statSync(target).isFile()
  )
    return false;
  const stat = fs.statSync(target);
  response.writeHead(200, {
    'Content-Type': mime[path.extname(target)] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': path.basename(target) === 'index.html' ? 'no-store' : 'public, max-age=3600',
  });
  fs.createReadStream(target).pipe(response);
  return true;
}
