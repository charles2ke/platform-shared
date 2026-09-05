import { createError } from '../shared/errors.js';

/**
 * Checks a role against `effectiveRoles` (roles expanded through registry
 * inheritance by `resolvePrincipal()`) and falls back to the raw token roles.
 */
export function hasRole(principal, role) {
  const roles = Array.isArray(principal?.effectiveRoles) ? principal.effectiveRoles : principal?.roles;
  return typeof role === 'string' && Array.isArray(roles) && roles.includes(role);
}

export function hasPermission(principal, permission) {
  if (typeof permission !== 'string' || !Array.isArray(principal?.permissions)) {
    return false;
  }

  return principal.permissions.some((grantedPermission) => permissionMatches(grantedPermission, permission));
}

/**
 * Returns true when role/permission requirements are satisfied.
 * Invalid requirement shapes fail closed and return false.
 */
export function meetsRequirements(principal, { roles = [], permissions = [], requireAllRoles = false, requireAllPermissions = true } = {}) {
  const normalizedRoles = normalizeRequirements(roles);
  const normalizedPermissions = normalizeRequirements(permissions);
  if (normalizedRoles === undefined || normalizedPermissions === undefined) {
    return false;
  }
  const roleCheck = normalizedRoles.length === 0 || (requireAllRoles ? normalizedRoles.every((role) => hasRole(principal, role)) : normalizedRoles.some((role) => hasRole(principal, role)));
  const permissionCheck = normalizedPermissions.length === 0
    || (requireAllPermissions
      ? normalizedPermissions.every((permission) => hasPermission(principal, permission))
      : normalizedPermissions.some((permission) => hasPermission(principal, permission)));
  return roleCheck && permissionCheck;
}

/**
 * @param {unknown} value A requirement string or an array of non-empty requirement strings.
 * @returns {string[]|undefined} Normalized requirement strings, or undefined when input is invalid.
 */
function normalizeRequirements(value) {
  if (typeof value === 'string') {
    return value.length > 0 ? [value] : undefined;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  if (!value.every((item) => typeof item === 'string' && item.length > 0)) {
    return undefined;
  }

  return value;
}

/**
 * Wildcards are only honored on the granted permission side.
 * `*` grants global access, while `resource:*` grants access to any
 * permission under the same scoped prefix.
 */
function permissionMatches(grantedPermission, requiredPermission) {
  if (typeof grantedPermission !== 'string' || grantedPermission.length === 0) {
    return false;
  }
  if (grantedPermission === '*') {
    return true;
  }
  if (grantedPermission === requiredPermission) {
    return true;
  }

  if (grantedPermission.endsWith(':*')) {
    const prefix = grantedPermission.slice(0, -1);
    return requiredPermission.startsWith(prefix) && requiredPermission.length > prefix.length;
  }

  return false;
}

/**
 * Builds a role -> permission registry so downstream apps can keep tokens small
 * and enforce permissions from roles. Roles may inherit other roles.
 *
 * @param {Record<string, string[]|{permissions?: string[], inherits?: string[]}>} definitions
 */
export function createRoleRegistry(definitions = {}) {
  if (definitions === null || typeof definitions !== 'object' || Array.isArray(definitions)) {
    throw createError('AUTH_INVALID_ROLE_REGISTRY', 'Role registry definitions must be an object', { status: 500 });
  }

  const normalized = new Map();
  for (const [role, definition] of Object.entries(definitions)) {
    const permissions = Array.isArray(definition) ? definition : definition?.permissions ?? [];
    const inherits = Array.isArray(definition) ? [] : definition?.inherits ?? [];
    if (normalizeRequirements(permissions) === undefined || normalizeRequirements(inherits) === undefined) {
      throw createError('AUTH_INVALID_ROLE_REGISTRY', `Role "${role}" must define permissions and inherits as string arrays`, { status: 500 });
    }
    normalized.set(role, { permissions, inherits });
  }

  function rolesForRole(role, seen = new Set()) {
    if (seen.has(role) || !normalized.has(role)) {
      return seen.has(role) ? [] : [role];
    }
    seen.add(role);
    return [role, ...normalized.get(role).inherits.flatMap((inheritedRole) => rolesForRole(inheritedRole, seen))];
  }

  function permissionsForRole(role, seen = new Set()) {
    if (seen.has(role)) {
      return [];
    }
    seen.add(role);
    const definition = normalized.get(role);
    if (!definition) {
      return [];
    }

    return [
      ...definition.permissions,
      ...definition.inherits.flatMap((inheritedRole) => permissionsForRole(inheritedRole, seen))
    ];
  }

  return {
    roles: () => [...normalized.keys()],
    /** Expands the supplied roles into themselves plus every inherited role. */
    rolesFor(roles = []) {
      const roleList = normalizeRequirements(roles) ?? [];
      const seen = new Set();
      return [...new Set(roleList.flatMap((role) => rolesForRole(role, seen)))];
    },
    /** Resolves the effective permissions granted by the supplied roles. */
    permissionsFor(roles = []) {
      const roleList = normalizeRequirements(roles) ?? [];
      const seen = new Set();
      return [...new Set(roleList.flatMap((role) => permissionsForRole(role, seen)))];
    }
  };
}

/**
 * Expands a principal with the permissions granted by its roles and records the
 * inherited roles on `effectiveRoles`, leaving the token `roles` untouched.
 * Returns the principal unchanged when no registry is supplied.
 */
export function resolvePrincipal(principal, roleRegistry) {
  if (!roleRegistry) {
    return principal;
  }
  if (typeof roleRegistry.permissionsFor !== 'function') {
    throw createError('AUTH_INVALID_ROLE_REGISTRY', 'roleRegistry must implement permissionsFor()', { status: 500 });
  }

  const roles = principal?.roles ?? [];
  const rolePermissions = roleRegistry.permissionsFor(roles);
  const effectiveRoles = typeof roleRegistry.rolesFor === 'function' ? roleRegistry.rolesFor(roles) : roles;
  return {
    ...principal,
    effectiveRoles: [...new Set([...roles, ...effectiveRoles])],
    permissions: [...new Set([...(principal?.permissions ?? []), ...rolePermissions])]
  };
}

/**
 * Enforces requirements outside of route guards (jobs, queue consumers, RPC).
 * Throws a 403 PlatformError when the principal is not authorized.
 */
export function authorize(principal, requirements = {}) {
  if (!meetsRequirements(principal, requirements)) {
    throw createError('AUTH_FORBIDDEN', 'Principal does not have required access', { status: 403, details: requirements });
  }

  return principal;
}
