import crypto from 'node:crypto';
import { timingSafeEqualText } from '../../shared/src/canonical.js';
import { MadeProofError } from '../../shared/src/errors.js';

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function hashPassword(password: string): string {
  if (password.length < 10)
    throw new MadeProofError('WEAK_PASSWORD', 'Password must contain at least 10 characters', 422);
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, n, r, p, saltValue, hashValue] = encoded.split('$');
  if (algorithm !== 'scrypt' || !n || !r || !p || !saltValue || !hashValue) return false;
  const derived = crypto.scryptSync(password, Buffer.from(saltValue, 'base64url'), 64, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqualText(derived.toString('base64url'), hashValue);
}

function keyFromSecret(secret: string): any {
  const decoded = Buffer.from(secret, 'base64');
  return decoded.length === 32 ? decoded : crypto.createHash('sha256').update(secret).digest();
}

export function encryptSecret(plaintext: string, masterKey: string, keyVersion = 1): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFromSecret(masterKey), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: keyVersion,
    iv: iv.toString('base64url'),
    tag: tag.toString('base64url'),
    data: ciphertext.toString('base64url'),
  });
}

export function decryptSecret(payload: string, masterKey: string): string {
  const parsed = JSON.parse(payload) as { iv: string; tag: string; data: string };
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    keyFromSecret(masterKey),
    Buffer.from(parsed.iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(parsed.data, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
