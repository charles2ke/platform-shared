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
examples/          Integration stubs for social, travel, workout, and basa
```

## Module responsibilities

### Auth

- Issues and verifies HMAC SHA-256 JWT access and refresh tokens.
- Provides `createAuthGuard()` and `protect()` helpers for framework-specific route wrappers.
- Includes RBAC scaffolding with role and permission checks.
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
- Defines a `ChannelAdapter` interface and ships `MockChannelAdapter` for default/local provider behavior.

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

## Downstream integration approach

1. Install or vendor this package in the consuming app.
2. Load app-specific env vars with `loadConfig()` or the app's existing config layer.
3. Wrap `createAuthGuard()` in the app's router middleware layer.
4. Replace in-memory stores/adapters with app-owned persistence and provider adapters by extending `AccountStore`, `ProfileStore`, or `ChannelAdapter` (or supplying objects with the same methods).
5. Keep domain-specific behavior in the app; keep shared identity/profile/notification contracts here.

See `examples/social.js`, `examples/travel.js`, `examples/workout.js`, and `examples/basa.js` for starting points.

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

Recommended next steps:

1. Publish the package or configure each app to consume it from GitHub.
2. Add persistent adapters for each app's user/account/profile data store.
3. Add real email, SMS, and push adapters behind the existing notification channel interface.
4. Standardize role and permission names across `social`, `travel`, `workout`, and `basa`.
