// Type-level smoke test: compiled by `npm run check:types` against the
// generated declarations via the package's own `exports` map. Never executed.
import {
  createAccessPolicy,
  createAuthGuard,
  createLoginThrottle,
  createRoleRegistry,
  InMemoryTokenRevocationStore,
  issueTokenPair,
  revokeSession,
  rotateTokenPair,
  verifyToken
} from '@charles2ke/platform-shared/auth';
import { CachedProfileStore, createRedisCache } from '@charles2ke/platform-shared/cache';
import {
  CHANNELS,
  InMemoryNotificationScheduler,
  MockChannelAdapter,
  NotificationService,
  isWithinQuietHours,
  quietHoursFromProfile
} from '@charles2ke/platform-shared/notifications';
import { InMemoryProfileStore, ProfileService } from '@charles2ke/platform-shared/profile';
import { MongoAccountStore, MongoProfileStore } from '@charles2ke/platform-shared/storage';
import { PlatformError } from '@charles2ke/platform-shared/shared';
import * as platform from '@charles2ke/platform-shared';

declare const secret: string;
declare const redisClient: { get(key: string): Promise<string | null>; set(...args: unknown[]): Promise<unknown>; del(key: string): Promise<number> };
declare const collection: any;

export async function smoke(): Promise<void> {
  // Auth
  const revocationStore = new InMemoryTokenRevocationStore();
  const roleRegistry = createRoleRegistry({ member: ['profile:read'], admin: { permissions: ['profile:write'], inherits: ['member'] } });
  const tokens = issueTokenPair({ subject: 'user-1', roles: ['member'], secret });
  const sessionId: string = tokens.sessionId;
  const payload = verifyToken(tokens.accessToken, { secret, expectedUse: 'access', revocationStore });
  revokeSession(payload, { revocationStore });
  rotateTokenPair(tokens.refreshToken, { secret, revocationStore });
  const guard = createAuthGuard({ secret, revocationStore, roleRegistry });
  const authorization = ['Bearer', tokens.accessToken].join(' ');
  guard({ headers: { authorization } }, { permissions: ['profile:read'] });

  const throttle = createLoginThrottle({ maxAttempts: 5 });
  const state = throttle.recordFailure('account:user@example.com');
  const allowed: boolean = state.allowed;
  const retryAfterMs: number = throttle.check('ip:10.0.0.1').retryAfterMs;
  throttle.assertAllowed('ip:10.0.0.1');
  throttle.recordSuccess('ip:10.0.0.1');

  const accounts = new MongoAccountStore({ collection });
  await accounts.upsert({ id: 'acct-1', email: 'user@example.com' });
  await accounts.findByEmail('user@example.com');

  // Profiles
  const policy = createAccessPolicy({ 'profile.update': { permissions: ['profile:write'] } }, { roleRegistry });
  const profiles = new ProfileService({ store: new MongoProfileStore({ collection }), policy, roleRegistry });
  const principal = { id: 'admin-1', roles: ['admin'] };
  const profile = await profiles.create({ displayName: 'Charles' }, { principal });
  await profiles.softDelete(profile.id, { principal });
  await profiles.restore(profile.id, { principal, status: 'inactive' });
  const page = await profiles.search({ query: 'char', limit: 10, principal });
  const nextCursor: string | undefined = page.nextCursor;
  await profiles.search({ cursor: nextCursor, includeDeleted: true });

  // Cache
  const cache = createRedisCache({ client: redisClient, ttlSeconds: 300, ttlByPrefix: { 'profile:': 600 } });
  const ttl: number = cache.ttlFor('profile:1');
  new CachedProfileStore({ store: new InMemoryProfileStore(), cache });

  // Notifications
  const notifications = new NotificationService({
    adapters: { [CHANNELS.EMAIL]: new MockChannelAdapter({ channel: CHANNELS.EMAIL }) },
    scheduler: new InMemoryNotificationScheduler(),
    retryDelayMs: 1_000
  });
  const quietHours = quietHoursFromProfile(profile);
  const result = await notifications.send(
    { id: 'n-1', channels: ['push', 'email'], strategy: 'fallback', quietHours, body: 'Hi' },
    { principal, now: new Date() }
  );
  const deferred: boolean | undefined = result.deferred;
  await notifications.schedule({ id: 'n-2', channels: 'email', body: 'Later' }, '2026-06-01T03:00:00Z');
  isWithinQuietHours(new Date(), { start: '22:00', end: '07:00', timezone: 'UTC' });

  // Shared and root namespace
  const error: PlatformError = new PlatformError({ code: 'X', message: 'x' });
  platform.auth.issueToken({ subject: 'user-1', secret });

  void [sessionId, allowed, retryAfterMs, ttl, deferred, error];
}
