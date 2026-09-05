export function hasRole(principal, role) {
  return typeof role === 'string'
    && Array.isArray(principal?.roles)
    && principal.roles.includes(role);
}

export function hasPermission(principal, permission) {
  if (typeof permission !== 'string' || !Array.isArray(principal?.permissions)) {
    return false;
  }

  return principal.permissions.some((grantedPermission) => permissionMatches(grantedPermission, permission));
}

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
