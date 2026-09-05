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
    if (revocationStore.isRevoked(payload) === true) {
      throw createError('AUTH_TOKEN_REVOKED', 'Token has been revoked', { status: 401 });
    }
  }

  return payload;
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
 */
export function rotateTokenPair(refreshToken, options = {}) {
  const payload = verifyToken(refreshToken, { ...options, expectedUse: 'refresh' });
  const { revocationStore, roles, permissions, claims } = options;
  if (revocationStore !== undefined) {
    if (typeof revocationStore.revokeToken !== 'function') {
      throw createError('AUTH_INVALID_REVOCATION_STORE', 'revocationStore must implement revokeToken() to rotate tokens', { status: 500 });
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
