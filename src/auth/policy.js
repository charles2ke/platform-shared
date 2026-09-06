import { createError } from '../shared/errors.js';
import { authorize, resolvePrincipal } from './rbac.js';

/**
 * Builds an access policy that services (profiles, notifications, jobs, queue
 * consumers) can enforce on every call, so RBAC is not limited to HTTP routes.
 *
 * @param {Record<string, {roles?: string[]|string, permissions?: string[]|string, requireAllRoles?: boolean, requireAllPermissions?: boolean}>} actions
 *   Requirement map keyed by action name, e.g. `{ 'profile.update': { permissions: ['profile:write'] } }`.
 * @param {{roleRegistry?: object, requirePrincipal?: boolean}} [options]
 *   `roleRegistry` expands roles into permissions before the check.
 *   `requirePrincipal` (default true) rejects calls made without a principal.
 */
export function createAccessPolicy(actions = {}, { roleRegistry, requirePrincipal = true } = {}) {
  if (actions === null || typeof actions !== 'object' || Array.isArray(actions)) {
    throw createError('AUTH_INVALID_POLICY', 'Access policy actions must be an object', { status: 500 });
  }

  const requirements = new Map();
  for (const [action, requirement] of Object.entries(actions)) {
    if (requirement === null || typeof requirement !== 'object' || Array.isArray(requirement)) {
      throw createError('AUTH_INVALID_POLICY', `Policy action "${action}" must map to a requirements object`, { status: 500 });
    }
    requirements.set(action, requirement);
  }

  return {
    actions: () => [...requirements.keys()],
    requirementsFor: (action) => requirements.get(action),
    /**
     * Enforces the requirements registered for `action`.
     * Actions without requirements are allowed; a missing principal is rejected
     * with 401 unless `requirePrincipal` is false.
     *
     * @returns {object|undefined} The resolved principal.
     */
    enforce(action, principal) {
      const requirement = requirements.get(action);
      if (requirement === undefined) {
        return principal;
      }

      if (principal === undefined || principal === null) {
        if (!requirePrincipal) {
          return principal;
        }
        throw createError('AUTH_PRINCIPAL_REQUIRED', `A principal is required for ${action}`, { status: 401, details: { action } });
      }

      const resolved = resolvePrincipal(principal, roleRegistry);
      try {
        return authorize(resolved, requirement);
      } catch (error) {
        throw createError('AUTH_FORBIDDEN', `Principal is not allowed to perform ${action}`, {
          status: 403,
          details: { action, ...requirement },
          cause: error
        });
      }
    }
  };
}

/**
 * Normalizes a `policy` service option: accepts a policy built by
 * `createAccessPolicy()`, a plain requirement map, or undefined (no checks).
 */
export function toAccessPolicy(policy, options) {
  if (policy === undefined || policy === null) {
    return undefined;
  }
  if (typeof policy.enforce === 'function') {
    return policy;
  }

  return createAccessPolicy(policy, options);
}
