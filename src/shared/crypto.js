import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { createError } from './errors.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

/** Derives a fixed-length key from an arbitrary-length secret via SHA-256. */
function deriveKey(secret) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw createError('CRYPTO_INVALID_KEY', 'encryption key must be a string of at least 16 characters', { status: 500 });
  }
  return createHash('sha256').update(secret).digest();
}

/**
 * Encrypts an arbitrary JSON-serializable value with AES-256-GCM so it can be
 * stored at rest (for example, in a dead-letter collection) without exposing
 * plain-text PII, while still being decryptable for replay.
 */
export function encryptJSON(value, secret) {
  const key = deriveKey(secret);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    v: 1,
    alg: ALGORITHM,
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
}

/** Reverses `encryptJSON()`. Throws `CRYPTO_DECRYPT_FAILED` on any tampering or key mismatch. */
export function decryptJSON(payload, secret) {
  if (!payload || payload.alg !== ALGORITHM || typeof payload.iv !== 'string' || typeof payload.authTag !== 'string' || typeof payload.ciphertext !== 'string') {
    throw createError('CRYPTO_DECRYPT_FAILED', 'encrypted payload is malformed', { status: 500 });
  }
  const key = deriveKey(secret);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, 'base64')), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch (error) {
    throw createError('CRYPTO_DECRYPT_FAILED', 'failed to decrypt payload', { status: 500, cause: error });
  }
}
