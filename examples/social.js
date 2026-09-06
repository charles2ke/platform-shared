import { createAuthGuard, createRoleRegistry, describeToken, InMemoryTokenRevocationStore, issueTokenPair, revokeSession, rotateTokenPair, verifyToken } from '../src/auth/index.js';
import { createExpressAuthMiddleware } from '../src/adapters/index.js';
import { ProfileService } from '../src/profile/index.js';

const SOCIAL_ROLES = createRoleRegistry({
  member: ['profile:read', 'post:create'],
  moderator: { permissions: ['post:delete'], inherits: ['member'] },
  admin: { permissions: ['*'], inherits: ['moderator'] }
});

/**
 * Social wires the full JWT lifecycle: issue -> guard -> rotate -> revoke.
 * Permissions stay out of the token and are resolved from roles at request time.
 */
export function createSocialPlatform({ jwtSecret, profileStore, audience = 'social', revocationStore = new InMemoryTokenRevocationStore(), reuseEvents = [] }) {
  const tokenOptions = { secret: jwtSecret, issuer: 'platform-shared', audience };
  const guard = createAuthGuard({ ...tokenOptions, revocationStore, roleRegistry: SOCIAL_ROLES });

  return {
    roles: SOCIAL_ROLES,
    revocationStore,
    profiles: new ProfileService({ store: profileStore }),
    requireMember: (request) => guard(request, { roles: ['member', 'moderator', 'admin'] }),
    requireModerator: (request) => guard(request, { permissions: ['post:delete'] }),
    login: (account) => issueTokenPair({ subject: account.id, roles: account.roles ?? ['member'], ...tokenOptions }),
    reuseEvents,
    // Replaying an already-rotated refresh token logs the subject out everywhere.
    refresh: (refreshToken) => rotateTokenPair(refreshToken, {
      ...tokenOptions,
      revocationStore,
      onReuseDetected: (event) => reuseEvents.push(event)
    }),
    // Session endpoint: expiry/role summary for the current access token.
    session: (accessToken) => describeToken(verifyToken(accessToken, { ...tokenOptions, expectedUse: 'access', revocationStore })),
    // Express/Connect apps mount the shared guard as middleware.
    memberMiddleware: createExpressAuthMiddleware(guard, { requirements: { roles: ['member', 'moderator', 'admin'] } }),
    logout: (payload) => revocationStore.revokeToken(payload),
    // Ends the whole session: the access token issued with this refresh token
    // stops verifying at the same time.
    logoutSession: (payload) => revokeSession(payload, { revocationStore }),
    logoutEverywhere: (subject) => revocationStore.revokeSubject(subject)
  };
}
