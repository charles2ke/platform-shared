import { createAuthGuard } from '../src/auth/index.js';
import { ProfileService } from '../src/profile/index.js';

export function createSocialPlatform({ jwtSecret, profileStore }) {
  return {
    requireMember: createAuthGuard({ secret: jwtSecret }),
    profiles: new ProfileService({ store: profileStore })
  };
}
