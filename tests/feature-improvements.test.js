import assert from 'node:assert/strict';
import test from 'node:test';
import { createLoginThrottle, createRoleRegistry } from '../src/auth/index.js';
import { CachedProfileStore, createRedisCache } from '../src/cache/index.js';
import { CHANNELS, DELIVERY_STATUS, MockChannelAdapter, NotificationService, isWithinQuietHours, nextAllowedDeliveryTime, normalizeQuietHours, quietHoursFromProfile } from '../src/notifications/index.js';
import { InMemoryProfileStore, ProfileService, searchProfiles } from '../src/profile/index.js';
import { MongoAccountStore, MongoProfileStore } from '../src/storage/index.js';

// --- Auth: login throttle ---------------------------------------------------

test('login throttle locks a key after maxAttempts failures and unlocks after lockoutMs', () => {
  let now = 0;
  const throttle = createLoginThrottle({ maxAttempts: 3, windowMs: 60_000, lockoutMs: 30_000, now: () => now });

  assert.equal(throttle.recordFailure('user@example.com').remaining, 2);
  assert.equal(throttle.recordFailure('user@example.com').remaining, 1);
  const locked = throttle.recordFailure('user@example.com');
  assert.equal(locked.allowed, false);
  assert.equal(locked.retryAfterMs, 30_000);
  assert.throws(() => throttle.assertAllowed('user@example.com'), (error) => {
    assert.equal(error.code, 'AUTH_LOGIN_LOCKED');
    assert.equal(error.status, 429);
    assert.equal(error.details.retryAfterSeconds, 30);
    return true;
  });
  assert.equal(throttle.check('other@example.com').allowed, true);

  now = 30_000;
  assert.equal(throttle.assertAllowed('user@example.com').remaining, 3);
});

test('login throttle forgets failures outside the window and on success', () => {
  let now = 0;
  const throttle = createLoginThrottle({ maxAttempts: 2, windowMs: 1_000, now: () => now });
  throttle.recordFailure('ip:10.0.0.1');
  now = 1_000;
  assert.equal(throttle.recordFailure('ip:10.0.0.1').allowed, true);
  assert.equal(throttle.recordSuccess('ip:10.0.0.1'), true);
  assert.equal(throttle.check('ip:10.0.0.1').failures, 0);
});

test('login throttle bounds memory and validates input', () => {
  const throttle = createLoginThrottle({ maxEntries: 2 });
  throttle.recordFailure('a');
  throttle.recordFailure('b');
  throttle.recordFailure('c');
  assert.equal(throttle.size(), 2);
  assert.equal(throttle.check('a').failures, 0);
  assert.throws(() => throttle.check(''), { code: 'AUTH_INVALID_THROTTLE_KEY' });
  assert.throws(() => createLoginThrottle({ maxAttempts: 0 }), { code: 'AUTH_INVALID_THROTTLE_CONFIG' });
});

test('login throttle does not lift active lockouts when flooded with new keys', () => {
  const throttle = createLoginThrottle({ maxAttempts: 2, maxEntries: 3 });
  throttle.recordFailure('victim');
  throttle.recordFailure('victim');
  for (const key of ['a', 'b', 'c', 'd', 'e']) {
    throttle.recordFailure(key);
  }
  assert.equal(throttle.check('victim').allowed, false);
  assert.equal(throttle.size(), 3);
});

// --- Mongo test double ------------------------------------------------------

function matches(document, filter) {
  return Object.entries(filter).every(([field, condition]) => {
    if (field === '$or') {
      return condition.some((branch) => matches(document, branch));
    }
    const value = field.split('.').reduce((current, part) => current?.[part], document);
    if (condition && typeof condition === 'object') {
      if ('$gt' in condition) return value > condition.$gt;
      if ('$ne' in condition) return value !== condition.$ne;
      if ('$regex' in condition) return typeof value === 'string' && new RegExp(condition.$regex, condition.$options).test(value);
    }
    return value === condition;
  });
}

/**
 * @param {{uniqueFields?: string[]}} [options]
 */
function fakeCollection({ uniqueFields = [] } = {}) {
  const documents = [];
  const project = (document) => (document ? structuredClone(document) : null);
  return {
    documents,
    filters: [],
    async findOne(filter) {
      return project(documents.find((document) => matches(document, filter)));
    },
    /** @param {any} filter @param {any} replacement @param {{upsert?: boolean}} [options] */
    async replaceOne(filter, replacement, { upsert } = {}) {
      const index = documents.findIndex((document) => matches(document, filter));
      for (const field of uniqueFields) {
        if (replacement[field] !== undefined && documents.some((document, i) => i !== index && document[field] === replacement[field])) {
          throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
        }
      }
      if (index >= 0) {
        documents[index] = structuredClone(replacement);
      } else if (upsert) {
        documents.push(structuredClone(replacement));
      }
      return { matchedCount: index >= 0 ? 1 : 0 };
    },
    async insertOne(document) {
      documents.push(structuredClone(document));
    },
    async updateOne(filter, update) {
      const document = documents.find((candidate) => matches(candidate, filter));
      if (!document) return { matchedCount: 0 };
      Object.assign(document, structuredClone(update.$set));
      for (const field of Object.keys(update.$unset ?? {})) delete document[field];
      return { matchedCount: 1 };
    },
    find(filter) {
      this.filters.push(filter);
      let results = documents.filter((document) => matches(document, filter));
      const cursor = {
        sort: () => { results = results.sort((a, b) => (a.id < b.id ? -1 : 1)); return cursor; },
        limit: (n) => { results = results.slice(0, n); return cursor; },
        toArray: async () => results.map(project)
      };
      return cursor;
    }
  };
}

test('MongoAccountStore upserts accounts and finds them by case-insensitive email', async () => {
  const collection = fakeCollection({ uniqueFields: ['emailLower'] });
  const store = new MongoAccountStore({ collection });

  const saved = await store.upsert({ id: 'acct-1', email: 'User@Example.com', passwordHash: 'hash' });
  assert.deepEqual(Object.keys(saved).sort(), ['email', 'id', 'passwordHash', 'updatedAt']);
  assert.equal((await store.findByEmail('user@EXAMPLE.com')).id, 'acct-1');
  assert.equal(await store.findByEmail({ $ne: null }), undefined);
  await assert.rejects(() => store.findById({ $ne: null }), { code: 'MONGO_INVALID_ID' });

  await assert.rejects(
    () => store.upsert({ id: 'acct-2', email: 'user@example.com' }),
    { code: 'AUTH_ACCOUNT_EMAIL_CONFLICT', status: 409 }
  );

  await store.upsert({ id: 'acct-1', email: 'new@example.com' });
  assert.equal(await store.findByEmail('user@example.com'), undefined);
  assert.equal((await store.findById('acct-1')).email, 'new@example.com');
});

// --- Profile: soft delete, restore, search ----------------------------------

async function seededService(options) {
  const service = new ProfileService(options);
  await service.create({ id: 'p-1', displayName: 'Alice Runner', contact: { email: 'alice@example.com' } });
  await service.create({ id: 'p-2', displayName: 'Bob Traveler', contact: { email: 'bob@example.com' } });
  await service.create({ id: 'p-3', displayName: 'Carol Runner', contact: { email: 'carol@example.org' } });
  return service;
}

test('soft-deletes and restores profiles', async () => {
  const service = await seededService();
  const deleted = await service.softDelete('p-1');
  assert.equal(deleted.status, 'deleted');
  assert.equal(typeof deleted.deletedAt, 'string');
  assert.equal((await service.softDelete('p-1')).deletedAt, deleted.deletedAt);

  const restored = await service.restore('p-1');
  assert.equal(restored.status, 'active');
  assert.equal('deletedAt' in restored, false);

  await assert.rejects(() => service.restore('p-1'), { code: 'PROFILE_NOT_DELETED', status: 409 });
  await service.softDelete('p-2');
  assert.equal((await service.restore('p-2', { status: 'inactive' })).status, 'inactive');
  await service.softDelete('p-2');
  await assert.rejects(() => service.restore('p-2', { status: 'deleted' }), { code: 'PROFILE_VALIDATION_FAILED' });
  await assert.rejects(() => service.softDelete('missing'), { code: 'PROFILE_NOT_FOUND' });
});

test('searches profiles with filtering and cursor pagination', async () => {
  const service = await seededService();
  await service.softDelete('p-3');

  assert.deepEqual((await service.search({ query: 'runner' })).items.map((p) => p.id), ['p-1']);
  assert.deepEqual((await service.search({ query: 'RUNNER', includeDeleted: true })).items.map((p) => p.id), ['p-1', 'p-3']);
  assert.deepEqual((await service.search({ status: 'deleted' })).items.map((p) => p.id), ['p-3']);
  assert.deepEqual((await service.search({ query: 'example.org', includeDeleted: true })).items.map((p) => p.id), ['p-3']);

  const first = await service.search({ limit: 1, includeDeleted: true });
  assert.deepEqual(first.items.map((p) => p.id), ['p-1']);
  assert.equal(first.nextCursor, 'p-1');
  const second = await service.search({ limit: 2, cursor: first.nextCursor, includeDeleted: true });
  assert.deepEqual(second.items.map((p) => p.id), ['p-2', 'p-3']);
  assert.equal(second.nextCursor, undefined);

  await assert.rejects(() => service.search({ limit: 0 }), { code: 'PROFILE_INVALID_SEARCH' });
  await assert.rejects(() => service.search({ query: { $ne: null } }), { code: 'PROFILE_INVALID_SEARCH' });
});

test('search falls back to list() for stores without search()', async () => {
  const backing = new InMemoryProfileStore();
  const store = { create: (p) => backing.create(p), get: (id) => backing.get(id), update: (id, p) => backing.update(id, p), delete: (id) => backing.delete(id), list: () => backing.list() };
  const service = await seededService({ store });
  assert.deepEqual((await service.search({ query: 'bob' })).items.map((p) => p.id), ['p-2']);
  assert.deepEqual(searchProfiles([{ id: 'x', displayName: 'X', status: 'deleted' }]).items, []);
});

test('restore and search fall back to delete and list policies when not configured', async () => {
  const service = await seededService({
    policy: {
      'profile.create': { roles: ['admin'] },
      'profile.delete': { roles: ['admin'] },
      'profile.list': { permissions: ['profile:read'] }
    },
    roleRegistry: createRoleRegistry({ admin: ['profile:read'], viewer: [] })
  }).catch(() => undefined);
  assert.equal(service, undefined, 'seeding without principal is rejected by the policy');

  const guarded = new ProfileService({
    policy: {
      'profile.delete': { roles: ['admin'] },
      'profile.list': { permissions: ['profile:read'] }
    },
    roleRegistry: createRoleRegistry({ admin: ['profile:read'], viewer: [] })
  });
  const admin = { id: 'admin', roles: ['admin'] };
  const viewer = { id: 'viewer', roles: ['viewer'] };
  await guarded.create({ id: 'p-9', displayName: 'Guarded' });
  await assert.rejects(() => guarded.softDelete('p-9', { principal: viewer }), { code: 'AUTH_FORBIDDEN' });
  await guarded.softDelete('p-9', { principal: admin });
  await assert.rejects(() => guarded.restore('p-9', { principal: viewer }), { code: 'AUTH_FORBIDDEN' });
  await assert.rejects(() => guarded.search({ principal: viewer }), { code: 'AUTH_FORBIDDEN' });
  assert.equal((await guarded.search({ principal: admin, includeDeleted: true })).items.length, 1);
  assert.equal((await guarded.restore('p-9', { principal: admin })).status, 'active');
});

test('update() status changes into or out of deleted follow soft delete and restore rules', async () => {
  const service = new ProfileService({
    policy: {
      'profile.update': { permissions: ['profile:write'] },
      'profile.delete': { roles: ['admin'] }
    },
    roleRegistry: createRoleRegistry({ admin: ['profile:write'], editor: ['profile:write'] })
  });
  const admin = { id: 'admin', roles: ['admin'] };
  const editor = { id: 'editor', roles: ['editor'] };
  await service.create({ id: 'p-u', displayName: 'Updatable' });

  await assert.rejects(() => service.update('p-u', { status: 'deleted' }, { principal: editor }), { code: 'AUTH_FORBIDDEN' });
  const deleted = await service.update('p-u', { status: 'deleted' }, { principal: admin });
  assert.equal(typeof deleted.deletedAt, 'string');

  await assert.rejects(() => service.update('p-u', { status: 'active' }, { principal: editor }), { code: 'AUTH_FORBIDDEN' });
  assert.equal((await service.update('p-u', { displayName: 'Still Deleted' }, { principal: editor })).deletedAt, deleted.deletedAt);
  const restored = await service.update('p-u', { status: 'active', deletedAt: 'ignored' }, { principal: admin });
  assert.equal(restored.status, 'active');
  assert.equal('deletedAt' in restored, false);
});

test('MongoProfileStore search escapes regex input and paginates; restore unsets deletedAt', async () => {
  const collection = fakeCollection();
  const service = new ProfileService({ store: new MongoProfileStore({ collection }) });
  await service.create({ id: 'm-1', displayName: 'Dot.Name', contact: { email: 'a@example.com' } });
  await service.create({ id: 'm-2', displayName: 'DotXName', contact: { email: 'b@example.com' } });

  assert.deepEqual((await service.search({ query: 'dot.name' })).items.map((p) => p.id), ['m-1']);
  assert.equal(collection.filters.at(-1).$or[0].displayName.$regex, 'dot\\.name');

  const page = await service.search({ limit: 1 });
  assert.equal(page.nextCursor, 'm-1');

  await service.softDelete('m-1');
  assert.deepEqual((await service.search({})).items.map((p) => p.id), ['m-2']);
  await service.restore('m-1');
  assert.equal('deletedAt' in collection.documents.find((d) => d.id === 'm-1'), false);
});

// --- Cache: per-prefix TTL --------------------------------------------------

function fakeRedis() {
  const calls = [];
  const data = new Map();
  return {
    calls,
    get: async (key) => data.get(key) ?? null,
    set: async (key, value, mode, ttl) => { calls.push({ key, ttl }); data.set(key, value); return 'OK'; },
    del: async (key) => (data.delete(key) ? 1 : 0)
  };
}

test('redis cache applies the longest matching ttlByPrefix rule', async () => {
  const client = fakeRedis();
  const cache = createRedisCache({ client, ttlSeconds: 300, ttlByPrefix: { 'profile:': 600, 'profile:hot:': 30 }, localCache: null });

  await cache.set('profile:1', { a: 1 });
  await cache.set('profile:hot:1', { a: 1 });
  await cache.set('session:1', { a: 1 });
  await cache.set('profile:2', { a: 1 }, { ttl: 5 });
  await cache.getOrLoad('profile:hot:2', async () => ({ a: 2 }));

  assert.deepEqual(client.calls.map((call) => call.ttl), [600, 30, 300, 5, 30]);
  assert.equal(cache.ttlFor('profile:hot:x'), 30);
  assert.throws(() => createRedisCache({ client, ttlByPrefix: { 'x:': 0 } }), { code: 'CACHE_INVALID_TTL' });
  assert.throws(() => createRedisCache({ client, ttlByPrefix: { '': 10 } }), { code: 'CACHE_INVALID_TTL' });
  assert.throws(() => createRedisCache({ client, ttlByPrefix: [] }), { code: 'CACHE_INVALID_TTL' });
});

test('CachedProfileStore passes search through to the underlying store', async () => {
  const store = new InMemoryProfileStore();
  const cached = new CachedProfileStore({ store, cache: createRedisCache({ client: fakeRedis() }) });
  const service = await seededService({ store: cached });
  assert.deepEqual((await service.search({ query: 'carol' })).items.map((p) => p.id), ['p-3']);
});

// --- Notifications: fallback strategy and quiet hours -----------------------

test('fallback strategy stops at the first channel that delivers', async () => {
  const push = new MockChannelAdapter({ channel: CHANNELS.PUSH, fail: true });
  const sms = new MockChannelAdapter({ channel: CHANNELS.SMS });
  const email = new MockChannelAdapter({ channel: CHANNELS.EMAIL });
  const service = new NotificationService({ adapters: { push, sms, email } });

  const result = await service.send({ id: 'n-1', channels: ['push', 'sms', 'email'], strategy: 'fallback', body: 'Hi' });
  assert.equal(result.status, DELIVERY_STATUS.SENT);
  assert.equal(result.strategy, 'fallback');
  assert.deepEqual(result.deliveries.map((d) => [d.channel, d.status]), [['push', 'failed'], ['sms', 'sent']]);
  assert.equal(email.deliveries.length, 0);

  const allFail = new NotificationService({ adapters: { push } });
  assert.equal((await allFail.send({ id: 'n-2', channels: ['push', 'sms'], strategy: 'fallback', body: 'Hi' })).status, DELIVERY_STATUS.FAILED);
  await assert.rejects(() => service.send({ id: 'n-3', channels: ['sms'], strategy: 'any', body: 'Hi' }), { code: 'NOTIFICATION_INVALID_STRATEGY' });
});

test('scheduled fallback notifications retry the full chain when every channel fails', async () => {
  const push = new MockChannelAdapter({ channel: CHANNELS.PUSH, fail: true });
  const service = new NotificationService({ adapters: { push }, retryDelayMs: 0 });
  await service.schedule({ id: 'n-4', channels: ['push', 'sms'], strategy: 'fallback', body: 'Hi' }, new Date(0));
  const run = await service.dispatchScheduled({ now: new Date(1) });
  assert.equal(run.retried, 1);
  assert.deepEqual((await service.listScheduled())[0].notification.channels, ['push', 'sms']);
});

test('quiet hours helpers handle wrap-around windows, timezones, and DST', () => {
  const quietHours = { start: '22:00', end: '07:00', timezone: 'America/New_York' };
  assert.equal(isWithinQuietHours('2026-06-02T02:15:00Z', quietHours), true);
  assert.equal(isWithinQuietHours('2026-06-01T15:00:00Z', quietHours), false);
  assert.equal(nextAllowedDeliveryTime('2026-06-02T02:15:30Z', quietHours).toISOString(), '2026-06-02T11:00:00.000Z');
  // Spring-forward and fall-back nights still end at 07:00 local time.
  assert.equal(nextAllowedDeliveryTime('2026-03-08T05:00:00Z', quietHours).toISOString(), '2026-03-08T11:00:00.000Z');
  assert.equal(nextAllowedDeliveryTime('2026-11-01T04:00:00Z', quietHours).toISOString(), '2026-11-01T12:00:00.000Z');
  assert.equal(isWithinQuietHours('2026-06-01T13:30:00Z', { start: '13:00', end: '14:00' }), true);

  assert.throws(() => normalizeQuietHours({ start: '25:00', end: '07:00' }), { code: 'NOTIFICATION_INVALID_QUIET_HOURS' });
  assert.throws(() => normalizeQuietHours({ start: '07:00', end: '07:00' }), { code: 'NOTIFICATION_INVALID_QUIET_HOURS' });
  assert.throws(() => normalizeQuietHours({ start: '22:00', end: '07:00', timezone: 'Mars/Base' }), { code: 'NOTIFICATION_INVALID_QUIET_HOURS' });

  assert.deepEqual(
    quietHoursFromProfile({ timezone: 'Europe/London', preferences: { quietHours: { start: '23:00', end: '06:00' } } }).timezone,
    'Europe/London'
  );
  assert.equal(quietHoursFromProfile({ preferences: {} }), undefined);
});

test('send() defers notifications during quiet hours and schedule() shifts into allowed time', async () => {
  const email = new MockChannelAdapter({ channel: CHANNELS.EMAIL });
  const service = new NotificationService({ adapters: { email } });
  const quietHours = { start: '22:00', end: '07:00', timezone: 'UTC' };

  const deferred = await service.send({ id: 'q-1', channels: 'email', body: 'Night', quietHours }, { now: new Date('2026-06-01T23:00:00Z') });
  assert.equal(deferred.status, DELIVERY_STATUS.PENDING);
  assert.equal(deferred.deferred, true);
  assert.equal(deferred.scheduledFor, '2026-06-02T07:00:00.000Z');
  assert.equal(email.deliveries.length, 0);

  const urgent = await service.send({ id: 'q-2', channels: 'email', body: 'Now', quietHours, bypassQuietHours: true }, { now: new Date('2026-06-01T23:00:00Z') });
  assert.equal(urgent.status, DELIVERY_STATUS.SENT);

  const daytime = await service.send({ id: 'q-3', channels: 'email', body: 'Day', quietHours }, { now: new Date('2026-06-01T12:00:00Z') });
  assert.equal(daytime.status, DELIVERY_STATUS.SENT);

  const scheduled = await service.schedule({ id: 'q-4', channels: 'email', body: 'Later', quietHours }, '2026-06-01T03:00:00Z');
  assert.equal(scheduled.scheduledFor, '2026-06-01T07:00:00.000Z');

  const run = await service.dispatchScheduled({ now: new Date('2026-06-02T07:00:00Z') });
  assert.equal(run.processed, 2);
  assert.equal(email.deliveries.length, 4);
});
