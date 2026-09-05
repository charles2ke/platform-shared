import { createAuthGuard, createRoleRegistry, InMemoryTokenRevocationStore, issueTokenPair, rotateTokenPair } from '../src/auth/index.js';
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
export function createSocialPlatform({ jwtSecret, profileStore, audience = 'social', revocationStore = new InMemoryTokenRevocationStore() }) {
  const tokenOptions = { secret: jwtSecret, issuer: 'platform-shared', audience };
  const guard = createAuthGuard({ ...tokenOptions, revocationStore, roleRegistry: SOCIAL_ROLES });

  return {
    roles: SOCIAL_ROLES,
    revocationStore,
    profiles: new ProfileService({ store: profileStore }),
    requireMember: (request) => guard(request, { roles: ['member', 'moderator', 'admin'] }),
    requireModerator: (request) => guard(request, { permissions: ['post:delete'] }),
    login: (account) => issueTokenPair({ subject: account.id, roles: account.roles ?? ['member'], ...tokenOptions }),
    refresh: (refreshToken) => rotateTokenPair(refreshToken, { ...tokenOptions, revocationStore }),
    logout: (payload) => revocationStore.revokeToken(payload),
    logoutEverywhere: (subject) => revocationStore.revokeSubject(subject)
  };
}
