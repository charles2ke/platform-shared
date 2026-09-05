import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createError } from '../shared/errors.js';

const textEncoder = new TextEncoder();

function base64UrlEncode(value) {
  const buffer = typeof value === 'string' ? Buffer.from(value) : Buffer.from(JSON.stringify(value));
  return buffer.toString('base64url');
}

function base64UrlJson(value) {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch (cause) {
    throw createError('AUTH_INVALID_TOKEN', 'Token segment is not valid JSON', { status: 401, cause });
  }
}

function sign(input, secret) {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

function assertSecret(secret) {
  if (!secret || typeof secret !== 'string' || secret.length < 32) {
    throw createError('AUTH_MISSING_SECRET', 'A JWT secret is required', { status: 500 });
  }
}

function secondsNow(now = new Date()) {
  return Math.floor(now.getTime() / 1000);
}

export function issueToken({ subject, roles = [], permissions = [], claims = {}, secret, issuer, audience, ttlSeconds = 900, now = new Date(), tokenUse = 'access' }) {
  assertSecret(secret);
  if (!subject) {
    throw createError('AUTH_MISSING_SUBJECT', 'Token subject is required', { status: 400 });
  }

  const iat = secondsNow(now);
  const payload = Object.fromEntries(Object.entries({
    ...claims,
    sub: subject,
    roles: [...new Set(roles)],
    permissions: [...new Set(permissions)],
    iss: issuer,
    aud: audience,
    iat,
    exp: iat + ttlSeconds,
    jti: claims.jti ?? randomUUID(),
    token_use: tokenUse
  }).filter(([, value]) => value !== undefined));

  const encodedHeader = base64UrlEncode({ alg: 'HS256', typ: 'JWT' });
  const encodedPayload = base64UrlEncode(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  return `${signingInput}.${sign(signingInput, secret)}`;
}

export function verifyToken(token, { secret, issuer, audience, now = new Date(), clockToleranceSeconds = 0, expectedUse, revocationStore } = {}) {
  assertSecret(secret);
  if (typeof token !== 'string') {
    throw createError('AUTH_INVALID_TOKEN', 'Token must be a string', { status: 401 });
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw createError('AUTH_INVALID_TOKEN', 'Token must have three segments', { status: 401 });
  }

  const [encodedHeader, encodedPayload, providedSignature] = parts;
  const header = base64UrlJson(encodedHeader);
  if (header.alg !== 'HS256') {
    throw createError('AUTH_UNSUPPORTED_ALGORITHM', 'Only HS256 JWTs are supported', { status: 401 });
  }

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = sign(signingInput, secret);
  const expectedBytes = textEncoder.encode(expectedSignature);
  const providedBytes = textEncoder.encode(providedSignature);
  if (expectedBytes.length !== providedBytes.length || !timingSafeEqual(expectedBytes, providedBytes)) {
    throw createError('AUTH_INVALID_SIGNATURE', 'Token signature is invalid', { status: 401 });
  }

  const payload = base64UrlJson(encodedPayload);
  const currentTime = secondsNow(now);
  if (payload.exp !== undefined && currentTime - clockToleranceSeconds >= payload.exp) {
    throw createError('AUTH_TOKEN_EXPIRED', 'Token has expired', { status: 401 });
  }
  if (payload.nbf !== undefined && currentTime + clockToleranceSeconds < payload.nbf) {
    throw createError('AUTH_TOKEN_NOT_ACTIVE', 'Token is not active yet', { status: 401 });
  }
  if (issuer !== undefined && payload.iss !== issuer) {
    throw createError('AUTH_INVALID_ISSUER', 'Token issuer is invalid', { status: 401 });
  }
  if (audience !== undefined && payload.aud !== audience) {
    throw createError('AUTH_INVALID_AUDIENCE', 'Token audience is invalid', { status: 401 });
  }
  if (expectedUse !== undefined && payload.token_use !== expectedUse) {
    throw createError('AUTH_INVALID_TOKEN_USE', 'Token use is invalid', { status: 401 });
  }
  if (revocationStore !== undefined) {
    if (typeof revocationStore.isRevoked !== 'function') {
      throw createError('AUTH_INVALID_REVOCATION_STORE', 'revocationStore must implement a synchronous isRevoked()', { status: 500 });
    }
    if (revocationStore.isRevoked(payload)) {
      throw createError('AUTH_TOKEN_REVOKED', 'Token has been revoked', { status: 401 });
    }
  }

  return payload;
}

/**
 * Decodes a token without verifying its signature. Use only for logging,
 * debugging, or routing decisions; never for authorization.
 */
export function decodeToken(token) {
  if (typeof token !== 'string') {
    throw createError('AUTH_INVALID_TOKEN', 'Token must be a string', { status: 401 });
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw createError('AUTH_INVALID_TOKEN', 'Token must have three segments', { status: 401 });
  }

  return { header: base64UrlJson(parts[0]), payload: base64UrlJson(parts[1]) };
}

/**
 * Summarizes a verified token payload for session/introspection endpoints.
 */
export function describeToken(payload, { now = new Date() } = {}) {
  if (!payload || typeof payload !== 'object') {
    throw createError('AUTH_INVALID_TOKEN', 'Token payload must be an object', { status: 401 });
  }

  const currentDate = now instanceof Date ? now : new Date(now);
  if (!(currentDate instanceof Date) || Number.isNaN(currentDate.getTime())) {
    throw createError('AUTH_INVALID_TOKEN', 'now must be a valid date', { status: 401 });
  }

  const currentTime = secondsNow(currentDate);
  const expiresInSeconds = typeof payload.exp === 'number' ? payload.exp - currentTime : undefined;
  return {
    subject: payload.sub,
    tokenId: payload.jti,
    tokenUse: payload.token_use,
    roles: payload.roles ?? [],
    permissions: payload.permissions ?? [],
    issuer: payload.iss,
    audience: payload.aud,
    issuedAt: typeof payload.iat === 'number' ? new Date(payload.iat * 1000).toISOString() : undefined,
    expiresAt: typeof payload.exp === 'number' ? new Date(payload.exp * 1000).toISOString() : undefined,
    expiresInSeconds,
    expired: expiresInSeconds !== undefined && expiresInSeconds <= 0
  };
}

export function issueTokenPair({ subject, roles = [], permissions = [], claims = {}, secret, issuer, audience, accessTokenTtlSeconds = 900, refreshTokenTtlSeconds = 2_592_000, now = new Date() }) {
  return {
    accessToken: issueToken({ subject, roles, permissions, claims, secret, issuer, audience, ttlSeconds: accessTokenTtlSeconds, now, tokenUse: 'access' }),
    refreshToken: issueToken({ subject, roles, permissions, claims, secret, issuer, audience, ttlSeconds: refreshTokenTtlSeconds, now, tokenUse: 'refresh' })
  };
}

export function refreshAccessToken(refreshToken, options = {}) {
  const payload = verifyToken(refreshToken, { ...options, expectedUse: 'refresh' });
  return issueAccessTokenFromRefreshPayload(payload, options);
}

/**
 * Verifies a refresh token, revokes it when a revocation store is provided, and
 * issues a brand new access/refresh pair. Use this to implement refresh token
 * rotation so a leaked refresh token cannot be replayed after rotation.
 *
 * When an already-rotated (revoked) refresh token is presented again, this is
 * treated as replay: every session for the subject is revoked (unless
 * `revokeSubjectOnReuse` is false), the optional `onReuseDetected` hook runs,
 * and an `AUTH_REFRESH_TOKEN_REUSED` error is thrown.
 */
export function rotateTokenPair(refreshToken, options = {}) {
  const { revocationStore, roles, permissions, claims, onReuseDetected, revokeSubjectOnReuse = true } = options;
  const payload = verifyToken(refreshToken, { ...options, revocationStore: undefined, expectedUse: 'refresh' });
  if (revocationStore !== undefined) {
    if (typeof revocationStore.revokeToken !== 'function' || typeof revocationStore.isRevoked !== 'function') {
      throw createError('AUTH_INVALID_REVOCATION_STORE', 'revocationStore must implement revokeToken() and isRevoked() to rotate tokens', { status: 500 });
    }
    if (revocationStore.isRevoked(payload)) {
      if (revokeSubjectOnReuse && typeof revocationStore.revokeSubject === 'function') {
        revocationStore.revokeSubject(payload.sub, { issuedBefore: options.now ?? new Date() });
      }
      if (typeof onReuseDetected === 'function') {
        onReuseDetected({ subject: payload.sub, payload });
      }
      throw createError('AUTH_REFRESH_TOKEN_REUSED', 'Refresh token has already been used', { status: 401, details: { subject: payload.sub } });
    }
    revocationStore.revokeToken(payload);
  }

  const pair = issueTokenPair({
    subject: payload.sub,
    roles: roles ?? payload.roles ?? [],
    permissions: permissions ?? payload.permissions ?? [],
    claims: claims ?? {},
    secret: options.secret,
    issuer: options.issuer,
    audience: options.audience,
    accessTokenTtlSeconds: options.accessTokenTtlSeconds ?? 900,
    refreshTokenTtlSeconds: options.refreshTokenTtlSeconds ?? 2_592_000,
    now: options.now
  });

  return { ...pair, rotatedFrom: payload };
}

function issueAccessTokenFromRefreshPayload(payload, options) {
  return issueToken({
    subject: payload.sub,
    roles: payload.roles ?? [],
    permissions: payload.permissions ?? [],
    secret: options.secret,
    issuer: options.issuer,
    audience: options.audience,
    ttlSeconds: options.accessTokenTtlSeconds ?? 900,
    now: options.now,
    tokenUse: 'access'
  });
}
