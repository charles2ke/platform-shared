export function hasRole(principal, role) {
  return Array.isArray(principal?.roles) && principal.roles.includes(role);
}

export function hasPermission(principal, permission) {
  return Array.isArray(principal?.permissions) && principal.permissions.includes(permission);
}

export function meetsRequirements(principal, { roles = [], permissions = [], requireAllRoles = false, requireAllPermissions = true } = {}) {
  const roleCheck = roles.length === 0 || (requireAllRoles ? roles.every((role) => hasRole(principal, role)) : roles.some((role) => hasRole(principal, role)));
  const permissionCheck = permissions.length === 0 || (requireAllPermissions ? permissions.every((permission) => hasPermission(principal, permission)) : permissions.some((permission) => hasPermission(principal, permission)));
  return roleCheck && permissionCheck;
}
