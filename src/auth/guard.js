import { createError } from '../shared/errors.js';
import { noopLogger } from '../shared/logger.js';
import { verifyToken } from './jwt.js';
import { meetsRequirements } from './rbac.js';

export function getBearerToken(request) {
  const headers = request?.headers;
  const authorization = headers?.authorization ?? headers?.Authorization ?? headers?.get?.('authorization');
  if (!authorization || typeof authorization !== 'string') {
    return undefined;
  }

  const separatorIndex = authorization.indexOf(' ');
  if (separatorIndex === -1) {
    return undefined;
  }

  const scheme = authorization.slice(0, separatorIndex);
  const token = authorization.slice(separatorIndex + 1).trim();
  return /^Bearer$/i.test(scheme) ? token : undefined;
}

export function createAuthGuard({ secret, issuer, audience, logger = noopLogger } = {}) {
  return function guard(request, requirements = {}) {
    const token = getBearerToken(request);
    if (!token) {
      throw createError('AUTH_MISSING_TOKEN', 'Access token is required', { status: 401 });
    }

    const payload = verifyToken(token, { secret, issuer, audience, expectedUse: 'access' });
    const principal = {
      id: payload.sub,
      roles: payload.roles ?? [],
      permissions: payload.permissions ?? [],
      claims: payload
    };

    if (!meetsRequirements(principal, requirements)) {
      logger.warn('Authorization failed', { subject: principal.id, requirements });
      throw createError('AUTH_FORBIDDEN', 'Principal does not have required access', { status: 403, details: requirements });
    }

    return principal;
  };
}

export function protect(handler, guard, requirements = {}) {
  return async function protectedHandler(request, ...args) {
    const principal = guard(request, requirements);
    return handler(request, { principal }, ...args);
  };
}
