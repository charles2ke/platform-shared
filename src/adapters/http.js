import { normalizeError } from '../shared/errors.js';

/**
 * Maps any thrown error to an HTTP status and a JSON body so every consumer
 * repo returns the same error envelope.
 */
export function toHttpErrorResponse(error) {
  const normalized = normalizeError(error);
  return { status: normalized.status ?? 500, body: normalized.toJSON() };
}

/**
 * Express/Connect-style middleware around `createAuthGuard()`.
 * On success it attaches the principal to `request[principalKey]` and calls
 * `next()`; on failure it answers with the shared error envelope.
 *
 * @param {Function} guard A guard created by `createAuthGuard()`.
 * @param {{requirements?: object, principalKey?: string}} [options]
 */
export function createExpressAuthMiddleware(guard, { requirements = {}, principalKey = 'principal' } = {}) {
  if (typeof guard !== 'function') {
    throw new TypeError('guard must be a function created by createAuthGuard()');
  }

  return function authMiddleware(request, response, next) {
    try {
      request[principalKey] = guard(request, requirements);
      next();
    } catch (error) {
      const { status, body } = toHttpErrorResponse(error);
      if (typeof response?.status === 'function' && typeof response?.json === 'function') {
        response.status(status).json(body);
        return;
      }
      next(error);
    }
  };
}

/**
 * Fetch/Web-standard handler wrapper (Next.js route handlers, Hono, workers).
 * Calls `handler(request, { principal })` when authorized and returns a JSON
 * response with the shared error envelope otherwise.
 *
 * @param {Function} handler Route handler.
 * @param {Function} guard A guard created by `createAuthGuard()`.
 * @param {object} [requirements] Role/permission requirements.
 */
export function withFetchAuth(handler, guard, requirements = {}) {
  return async function authorizedHandler(request, ...args) {
    let principal;
    try {
      principal = guard(request, requirements);
    } catch (error) {
      const { status, body } = toHttpErrorResponse(error);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }

    return handler(request, { principal }, ...args);
  };
}
