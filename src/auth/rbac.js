export function hasRole(principal, role) {
  return typeof role === 'string'
    && Array.isArray(principal?.roles)
    && principal.roles.some((currentRole) => currentRole === role);
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
  const roleCheck = normalizedRoles.length === 0 || (requireAllRoles ? normalizedRoles.every((role) => hasRole(principal, role)) : normalizedRoles.some((role) => hasRole(principal, role)));
  const permissionCheck = normalizedPermissions.length === 0
    || (requireAllPermissions
      ? normalizedPermissions.every((permission) => hasPermission(principal, permission))
      : normalizedPermissions.some((permission) => hasPermission(principal, permission)));
  return roleCheck && permissionCheck;
}

function normalizeRequirements(value) {
  if (typeof value === 'string') {
    return value ? [value] : [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item) => typeof item === 'string' && item.length > 0);
}

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

  if (grantedPermission.endsWith('*')) {
    return requiredPermission.startsWith(grantedPermission.slice(0, -1));
  }

  return false;
}
