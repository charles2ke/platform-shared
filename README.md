# platform-shared

Shared platform foundations for authentication, profiles, and notifications across `social`, `travel`, `workout`, and `basa`.

## Architecture overview

This package is intentionally framework-light and dependency-free. Core business logic lives in reusable modules under `src/`, while app-specific HTTP, queue, or serverless integration should wrap these modules in each downstream repository.

```text
src/
  auth/            JWT issuing/verification, refresh pattern, route guards, RBAC helpers
  profile/         Canonical profile model validation plus CRUD service and memory adapter
  notifications/   Unified send/schedule API, template rendering, channel adapters
  shared/          Environment config, structured errors, logging hooks
  adapters/        Framework/provider adapters: HTTP middleware, HTTP channel, worker loop
examples/          Integration stubs for social, travel, workout, and basa
```

## Module responsibilities

### Auth

- Issues and verifies HMAC SHA-256 JWT access and refresh tokens.
- Covers the full token lifecycle: `issueTokenPair()`, `refreshAccessToken()`, `rotateTokenPair()` for refresh-token rotation, and revocation through a `TokenRevocationStore`.
- `rotateTokenPair()` detects refresh-token replay: presenting an already-rotated refresh token revokes every session for the subject (unless `revokeSubjectOnReuse: false`), invokes the optional `onReuseDetected({ subject, payload })` hook, and throws `AUTH_REFRESH_TOKEN_REUSED`.
- `decodeToken()` inspects a token without verifying it (logging/debugging only), and `describeToken()` summarizes a verified payload (`issuedAt`, `expiresAt`, `expiresInSeconds`, `expired`) for session/introspection endpoints.
- `InMemoryTokenRevocationStore` supports single-token revocation (`revokeToken()`), "log out everywhere" (`revokeSubject()`), and `prune()` for expired entries. Implementations must be synchronous so guards stay synchronous.
- Provides `createAuthGuard()` and `protect()` helpers for framework-specific route wrappers. Guards accept `revocationStore` and `roleRegistry` so revocation and RBAC are enforced on every request.
- `issueTokenPair()` stamps a shared session id (`sid`) on the access and refresh token and returns it as `sessionId`, so one login can be revoked as a unit. `revokeSession(payload, { revocationStore })` ends that session (logout) and falls back to single-token revocation for tokens issued without a `sid`. Each `rotateTokenPair()` call starts a new session unless `sessionId` is passed; replaying a rotated refresh token also revokes the replayed session.
- Includes RBAC scaffolding with role and permission checks, a `createRoleRegistry()` role-to-permission map with inheritance, `resolvePrincipal()` for expanding token roles into permissions, and `authorize()` for enforcement outside route guards.
- Role inheritance also applies to role checks: `registry.rolesFor()` expands inherited roles and `resolvePrincipal()` stores them on `principal.effectiveRoles` (token `roles` stay untouched), so a `coach` that inherits `athlete` satisfies `{ roles: ['athlete'] }`.
- `createAccessPolicy({ 'profile.update': { permissions: ['profile:write'] } })` maps action names to requirements so RBAC is enforced inside services, jobs, and queue consumers, not only on HTTP routes. `ProfileService` and `NotificationService` accept the resulting `policy` (or a plain requirement map) and a `roleRegistry`; callers then pass `{ principal }` per call. Actions without requirements stay open; a missing principal fails with `AUTH_PRINCIPAL_REQUIRED` unless `requirePrincipal: false`.
- Exposes an `AccountStore` interface plus an `InMemoryAccountStore` default that can be replaced by persistent adapters later.

### Profile

- Uses a canonical profile shape: `id`, `displayName`, `contact`, `preferences`, `timezone`, `locale`, `avatarUrl`, `status`, and `metadata`.
- Normalizes display names, email addresses, locale/timezone defaults, and status.
- Provides validation helpers and `ProfileService` over the replaceable `ProfileStore` interface.
- Ships `InMemoryProfileStore` for tests, prototypes, and local development.

### Notifications

- Provides one API for sending or scheduling notifications.
- Supports email, SMS, and push channel abstraction.
- Renders `{{variable}}` template placeholders from provided variables.
- Returns delivery status objects with `sent`, `failed`, `partial`, or `pending` states.
- Includes an in-memory scheduling workflow via `schedule()` and `dispatchScheduled()` for queue handoff patterns.
- Ships a `NotificationScheduler` interface plus `InMemoryNotificationScheduler` (enqueue/dequeueDue/requeue/countPending/list) as a reference queue adapter.
- Retries use configurable exponential backoff: `retryDelayMs * retryBackoffFactor ** (attempts - 1)`, capped by `maxRetryDelayMs`. `retryDelayFor(attempts)` exposes the computed delay.
- Exhausted retries (or schedulers without `requeue()`) call the optional `onDeadLetter({ notification, attempts, reason })` hook; `dispatchScheduled()` reports `retried` and `deadLettered` counts and per-result `attempts`, `retryScheduledFor`, and `deadLettered`.
- `dispatchScheduled()` returns `pending` plus `pendingKnown`; when an injected scheduler does not expose `countPending()`, `pending` is `0` and `pendingKnown` is `false`.
- In-memory retries honor `maxScheduleAttempts` and `retryDelayMs`; injected schedulers can support retries by implementing `requeue()`.
- `maxScheduleAttempts` bounds total delivery attempts (initial attempt included). Scheduler adapters should return wrapped due entries as `{ notification, scheduledFor }` (or `{ notification, when }`).
- `listScheduled()` returns pending entries and `cancelScheduled(notificationId)` drops queued deliveries (trip cancelled, workout completed early); injected schedulers must implement `list()` and `cancel()` for these.
- Partial failures are retried per channel: only the channels that failed are re-queued (`result.retryChannels`), so delivered channels are never sent twice. Set `retryPartialFailures: false` to keep the previous behavior.
- A `deadLetterStore` (see `DeadLetterStore` / `InMemoryDeadLetterQueue`) persists `{ notification, attempts, reason, channels, failedAt }` records for exhausted retries so failures can be inspected and replayed with `replayDeadLetters()`.
- Enforces the shared access policy on `send()`, `schedule()`, `listScheduled()`, `cancelScheduled()`, and `dispatchScheduled()` when `policy` is supplied.
- Defines a `ChannelAdapter` interface and ships `MockChannelAdapter` for default/local provider behavior.

### Adapters

- `createExpressAuthMiddleware(guard, { requirements })` mounts a guard in Express/Connect apps and answers with the shared error envelope; `withFetchAuth(handler, guard, requirements)` does the same for fetch-style route handlers (Next.js, Hono, workers).
- `toHttpErrorResponse(error)` maps any error to `{ status, body }` for consistent API error responses.
- `HttpChannelAdapter` is a concrete channel adapter that POSTs rendered notifications to a provider endpoint, with `headers`, `transform`, and `timeoutMs` options.
- `createNotificationWorker(service, { intervalMs })` drains scheduled notifications from a cron trigger (`runOnce()`) or a long-running worker (`start()` / `stop()`), and `replayDeadLetters({ service, store })` re-queues dead-lettered notifications after an outage.

### Shared

- `loadConfig()` reads environment configuration.
- `PlatformError` gives structured error objects with code, status, message, and details.
- Logger hooks accept any object with `debug`, `info`, `warn`, and `error` methods.

## Environment variables

Copy `.env.example` and set values in each app environment.

| Variable | Required | Purpose |
| --- | --- | --- |
| `PLATFORM_JWT_SECRET` | Production yes | JWT HMAC secret; use at least 32 random characters. |
| `PLATFORM_JWT_ISSUER` | No | JWT issuer, defaults to `platform-shared`. |
| `PLATFORM_JWT_AUDIENCE` | No | App or API audience to verify. |
| `PLATFORM_JWT_ACCESS_TTL_SECONDS` | No | Access token TTL, defaults to 900 seconds. |
| `PLATFORM_JWT_REFRESH_TTL_SECONDS` | No | Refresh token TTL, defaults to 30 days. |
| `PLATFORM_DEFAULT_LOCALE` | No | Profile default locale, defaults to `en-US`. |
| `PLATFORM_DEFAULT_TIMEZONE` | No | Profile default timezone, defaults to `UTC`. |
| `PLATFORM_DEFAULT_FROM_EMAIL` | No | Default email sender for provider adapters. |
| `PLATFORM_DEFAULT_SMS_SENDER` | No | Default SMS sender for provider adapters. |
| `PLATFORM_DEFAULT_PUSH_SENDER` | No | Default push sender for provider adapters. |

## Usage snippets

### Issue and verify auth tokens

```js
import { issueTokenPair, createAuthGuard } from '@charles2ke/platform-shared/auth';

const tokens = issueTokenPair({
  subject: 'user-123',
  roles: ['member'],
  permissions: ['profile:read'],
  secret: process.env.PLATFORM_JWT_SECRET,
  issuer: 'platform-shared',
  audience: 'social'
});

const guard = createAuthGuard({
  secret: process.env.PLATFORM_JWT_SECRET,
  issuer: 'platform-shared',
  audience: 'social'
});

const principal = guard(request, { permissions: ['profile:read'] });
```

### Rotate, revoke, and map roles to permissions

```js
import {
  createAuthGuard,
  createRoleRegistry,
  describeToken,
  InMemoryTokenRevocationStore,
  rotateTokenPair
} from '@charles2ke/platform-shared/auth';

const revocationStore = new InMemoryTokenRevocationStore();
const roleRegistry = createRoleRegistry({
  member: ['profile:read'],
  moderator: { permissions: ['post:delete'], inherits: ['member'] }
});

const guard = createAuthGuard({ secret, issuer: 'platform-shared', audience: 'social', revocationStore, roleRegistry });

// Refresh endpoint: rotate the pair, revoke the presented refresh token, and
// treat a replayed refresh token as a compromise (all sessions are revoked).
const rotated = rotateTokenPair(refreshToken, {
  secret,
  issuer: 'platform-shared',
  audience: 'social',
  revocationStore,
  onReuseDetected: ({ subject }) => securityLog.warn('refresh token replay', { subject })
});

// Session/introspection endpoint.
const session = describeToken(principal.claims); // { expiresAt, expiresInSeconds, expired, ... }

// Inherited roles are available on principal.effectiveRoles.
guard(request, { roles: ['member'] });

// Logout endpoints.
revokeSession(principal.claims, { revocationStore }); // ends this login (access + refresh)
revocationStore.revokeToken(principal.claims);        // single token
revocationStore.revokeSubject('user-123');            // everywhere
```

### Enforce RBAC inside services, jobs, and consumers

```js
import { createAccessPolicy } from '@charles2ke/platform-shared/auth';
import { ProfileService } from '@charles2ke/platform-shared/profile';

const policy = createAccessPolicy({
  'profile.get': { permissions: ['profile:read'] },
  'profile.update': { permissions: ['profile:write'] },
  'profile.delete': { roles: ['admin'] }
}, { roleRegistry });

const profiles = new ProfileService({ store, policy });

await profiles.update(id, { timezone: 'Africa/Nairobi' }, { principal });
```

### Mount guards and providers in a consumer repo

```js
import { createExpressAuthMiddleware, createNotificationWorker, HttpChannelAdapter, replayDeadLetters, withFetchAuth } from '@charles2ke/platform-shared/adapters';

app.get('/feed', createExpressAuthMiddleware(guard, { requirements: { roles: ['member'] } }), handler);

export const GET = withFetchAuth(routeHandler, guard, { permissions: ['profile:read'] });

const notifications = new NotificationService({
  adapters: { email: new HttpChannelAdapter({ channel: 'email', endpoint: process.env.EMAIL_WEBHOOK_URL, headers: { authorization: providerKey } }) },
  scheduler,
  deadLetterStore
});

const worker = createNotificationWorker(notifications, { intervalMs: 60_000 });
worker.start();

await replayDeadLetters({ service: notifications, store: deadLetterStore });
```

### Manage profiles

```js
import { ProfileService } from '@charles2ke/platform-shared/profile';

const profiles = new ProfileService({ defaults: { locale: 'en-US', timezone: 'UTC' } });

const profile = await profiles.create({
  displayName: 'Charles',
  contact: { email: 'charles@example.com' },
  preferences: { units: 'metric' }
});
```

### Plug in persistent stores and providers

```js
import { ProfileStore } from '@charles2ke/platform-shared/profile';
import { ChannelAdapter } from '@charles2ke/platform-shared/notifications';

class SqlProfileStore extends ProfileStore {
  async create(profile) { /* app-owned persistence */ }
  async get(id) { /* ... */ }
  async update(id, profile) { /* ... */ }
  async delete(id) { /* ... */ }
  async list() { /* ... */ }
}

class EmailProviderAdapter extends ChannelAdapter {
  async send(message) { /* call provider, return a delivery status object */ }
}
```

Unimplemented interface methods throw structured `PlatformError`s instead of failing silently.

### Send notifications

```js
import { CHANNELS, MockChannelAdapter, NotificationService } from '@charles2ke/platform-shared/notifications';

const notifications = new NotificationService({
  adapters: {
    [CHANNELS.EMAIL]: new MockChannelAdapter({ channel: CHANNELS.EMAIL }),
    [CHANNELS.PUSH]: new MockChannelAdapter({ channel: CHANNELS.PUSH })
  }
});

await notifications.send({
  channels: [CHANNELS.EMAIL, CHANNELS.PUSH],
  to: { email: 'user@example.com', userId: 'user-123' },
  subject: 'Welcome {{name}}',
  body: 'Hi {{name}}, your account is ready.',
  variables: { name: 'Charles' }
});
```

### Schedule notifications with retries

```js
import { InMemoryNotificationScheduler, NotificationService } from '@charles2ke/platform-shared/notifications';

const scheduler = new InMemoryNotificationScheduler(); // swap for a queue-backed adapter
const notifications = new NotificationService({
  adapters,
  scheduler,
  maxScheduleAttempts: 4,
  retryDelayMs: 30_000,
  retryBackoffFactor: 2,
  maxRetryDelayMs: 15 * 60_000,
  deadLetterStore, // durable record of exhausted retries, replayable later
  onDeadLetter: ({ notification, attempts, reason }) => auditLog.write({ notification, attempts, reason })
});

await notifications.schedule(reminder, new Date(Date.now() + 60_000));

// Cron/worker loop
const { processed, retried, deadLettered, pending } = await notifications.dispatchScheduled();

// Cancel queued deliveries when the underlying event changes.
await notifications.listScheduled();
await notifications.cancelScheduled(reminder.id);
```

## Downstream integration approach

1. Install or vendor this package in the consuming app.
2. Load app-specific env vars with `loadConfig()` or the app's existing config layer.
3. Wrap `createAuthGuard()` in the app's router middleware layer.
4. Replace in-memory stores/adapters with app-owned persistence and provider adapters by extending `AccountStore`, `ProfileStore`, `ChannelAdapter`, `NotificationScheduler`, or `TokenRevocationStore` (or supplying objects with the same methods).
5. Keep domain-specific behavior in the app; keep shared identity/profile/notification contracts here.

See `examples/social.js`, `examples/travel.js`, `examples/workout.js`, and `examples/basa.js` for starting points. They are executable stubs covered by `tests/examples.test.js`:

| Example | Shows |
| --- | --- |
| `social.js` | Login, guarded routes (including Express middleware), refresh-token rotation with replay detection, session introspection, session/single-token/global logout, role registry. |
| `workout.js` | Role-derived and inherited-role permissions, `authorize()` in service code, scheduled push nudges with exponential backoff, cancellation, and dead lettering. |
| `travel.js` | Immediate and scheduled multi-channel reminders drained by `createNotificationWorker()`, plus pending listing, cancellation, dead-letter capture, and replay. |
| `basa.js` | RBAC-guarded order operations, policy-enforced profile CRUD (`createAccessPolicy()`), and scheduled email/SMS order updates with pending listing and cancellation. |

## Migration/adoption checklist

### social

- [ ] Use shared JWT issuing/verification for login and protected social routes.
- [ ] Map existing user profile fields to the canonical profile model.
- [ ] Replace local notification calls with `NotificationService` channel adapters.
- [ ] Add social-specific persistent account/profile store adapters.

### travel

- [ ] Verify API/mobile tokens with `createAuthGuard()` and travel audience settings.
- [ ] Store traveler locale/timezone/preferences through `ProfileService`.
- [ ] Route trip reminders through email and push adapters.
- [ ] Add provider-specific retry/queue integration around notification delivery.

### workout

- [ ] Guard workout read/write routes with shared permission names.
- [ ] Use profile preferences for units, timezone, and notification settings.
- [ ] Send workout nudges through push notifications.
- [ ] Add persistent adapters for workout user profiles.

### basa

- [ ] Align customer account auth with shared token claims and RBAC scaffolding.
- [ ] Normalize customer contact metadata with the canonical profile model.
- [ ] Route order updates through email/SMS adapters.
- [ ] Add commerce-specific permissions and persistent stores.

## Testing and local run instructions

This repository uses Node's built-in test runner and has no external runtime dependencies.

```bash
npm test
npm run build
```

`npm run build` performs syntax checks across source, tests, examples, and scripts.

## Architecture decisions and next steps

- JWT support is implemented with built-in Node `crypto` and HS256 to avoid introducing dependencies before provider decisions are made.
- Guards are request-shape based instead of Express/Fastify/Next specific, so each app can adapt them to its framework.
- Store and channel adapters are constructor-injected to make persistence and provider migration explicit.
- Notification scheduling supports in-memory queuing for local workflow depth; downstream apps should still connect production queues/schedulers through adapters.
- Token revocation is an injectable synchronous store so guards remain synchronous; production apps back it with a cache warmed from their session store.
- Access and refresh tokens carry a shared session id so logout and refresh-token replay can close a whole login without revoking every session for a subject.
- Authorization is expressed as action-keyed policies rather than hard-coded checks, so the same requirements apply to HTTP routes, background jobs, and queue consumers.
- Framework and provider glue lives in `src/adapters/` so the core modules stay framework-light while consumer repos get working starting points.

Recommended next steps:

1. Publish the package or configure each app to consume it from GitHub.
2. Add persistent adapters for each app's user/account/profile data store.
3. Add real email, SMS, and push adapters behind the existing notification channel interface (`HttpChannelAdapter` covers HTTP providers).
4. Standardize role and permission names across `social`, `travel`, `workout`, and `basa`.
