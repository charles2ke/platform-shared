import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthGuard, issueTokenPair } from '../src/auth/index.js';
import { CHANNELS, DELIVERY_STATUS, InMemoryDeadLetterQueue, MockChannelAdapter, NotificationService } from '../src/notifications/index.js';
import { createExpressAuthMiddleware, createNotificationWorker, HttpChannelAdapter, replayDeadLetters, toHttpErrorResponse, withFetchAuth } from '../src/adapters/index.js';

const secret = 'adapter-secret-that-is-long-enough-ok';

function bearer(token) {
  return { headers: { authorization: 'Bearer ' + token } };
}

function fakeResponse() {
  const sent = {};
  return {
    sent,
    status(code) {
      sent.status = code;
      return this;
    },
    json(body) {
      sent.body = body;
      return this;
    }
  };
}

test('express middleware attaches the principal and rejects unauthorized requests', () => {
  const guard = createAuthGuard({ secret });
  const middleware = createExpressAuthMiddleware(guard, { requirements: { roles: ['member'] } });
  const { accessToken } = issueTokenPair({ subject: 'user-1', roles: ['member'], secret });

  const request = bearer(accessToken);
  let nextCalls = 0;
  middleware(request, fakeResponse(), () => {
    nextCalls += 1;
  });
  assert.equal(nextCalls, 1);
  assert.equal(request.principal.id, 'user-1');

  const response = fakeResponse();
  middleware({ headers: {} }, response, () => {
    throw new Error('next should not run');
  });
  assert.equal(response.sent.status, 401);
  assert.equal(response.sent.body.error.code, 'AUTH_MISSING_TOKEN');

  assert.throws(() => createExpressAuthMiddleware('not-a-guard'), TypeError);
});

test('express middleware forwards errors when the response cannot answer', () => {
  const middleware = createExpressAuthMiddleware(createAuthGuard({ secret }));
  let forwarded;
  middleware({ headers: {} }, {}, (error) => {
    forwarded = error;
  });
  assert.equal(forwarded.code, 'AUTH_MISSING_TOKEN');
  assert.equal(toHttpErrorResponse(new Error('boom')).status, 500);
});

test('fetch handler wrapper authorizes web-standard requests', async () => {
  const guard = createAuthGuard({ secret });
  const handler = withFetchAuth(async (_request, { principal }) => principal.id, guard, { permissions: ['profile:read'] });
  const { accessToken } = issueTokenPair({ subject: 'user-2', permissions: ['profile:read'], secret });

  assert.equal(await handler(bearer(accessToken)), 'user-2');

  const denied = await handler(bearer(issueTokenPair({ subject: 'user-3', secret }).accessToken));
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'AUTH_FORBIDDEN');
});

test('http channel adapter posts rendered messages to a provider', async () => {
  const calls = [];
  const adapter = new HttpChannelAdapter({
    channel: CHANNELS.EMAIL,
    endpoint: 'https://provider.example/send',
    headers: { 'x-provider-key': 'provider-key' },
    transform: (message) => ({ to: message.to?.email, text: message.body }),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 202, headers: { get: () => 'provider-1' } };
    }
  });

  const delivery = await adapter.send({ to: { email: 'user@example.com' }, body: 'hello' });
  assert.equal(delivery.status, DELIVERY_STATUS.SENT);
  assert.equal(delivery.providerMessageId, 'provider-1');
  assert.deepEqual(JSON.parse(calls[0].init.body), { to: 'user@example.com', text: 'hello' });
  assert.equal(calls[0].init.headers['x-provider-key'], 'provider-key');
});

test('http channel adapter surfaces provider failures as platform errors', async () => {
  const failing = new HttpChannelAdapter({
    channel: CHANNELS.SMS,
    endpoint: 'https://provider.example/send',
    fetchImpl: async () => ({ ok: false, status: 500 })
  });
  await assert.rejects(() => failing.send({ body: 'hi' }), { code: 'NOTIFICATION_PROVIDER_ERROR', status: 502 });

  const unreachable = new HttpChannelAdapter({
    channel: CHANNELS.SMS,
    endpoint: 'https://provider.example/send',
    fetchImpl: async () => {
      throw new Error('socket hang up');
    }
  });
  await assert.rejects(() => unreachable.send({ body: 'hi' }), { code: 'NOTIFICATION_PROVIDER_UNREACHABLE' });

  assert.throws(() => new HttpChannelAdapter({ channel: CHANNELS.SMS }), { code: 'NOTIFICATION_ADAPTER_MISCONFIGURED' });
  assert.throws(() => new HttpChannelAdapter({ endpoint: 'https://x', fetchImpl: 'no' }), { code: 'NOTIFICATION_ADAPTER_MISCONFIGURED' });
  assert.throws(() => new HttpChannelAdapter({ endpoint: 'https://x', fetchImpl: async () => ({}), transform: 'no' }), { code: 'NOTIFICATION_ADAPTER_MISCONFIGURED' });
});

test('notification worker drains due notifications on demand and on an interval', async () => {
  const email = new MockChannelAdapter({ channel: CHANNELS.EMAIL });
  const service = new NotificationService({ adapters: { email } });
  const worker = createNotificationWorker(service, { intervalMs: 1000 });

  await service.schedule({ id: 'worker-1', channels: [CHANNELS.EMAIL], body: 'hi' }, new Date('2026-01-01T00:00:00Z'));
  const summary = await worker.runOnce(new Date('2026-01-01T00:00:00Z'));
  assert.equal(summary.processed, 1);
  assert.equal(email.deliveries.length, 1);

  let scheduled;
  const worker2 = createNotificationWorker(service, {
    setIntervalImpl: (callback) => {
      scheduled = callback;
      return 'timer';
    },
    clearIntervalImpl: () => {}
  });
  assert.equal(worker2.isRunning(), false);
  assert.equal(worker2.start(), 'timer');
  assert.equal(worker2.start(), 'timer');
  assert.equal(worker2.isRunning(), true);
  scheduled();
  worker2.stop();
  assert.equal(worker2.isRunning(), false);

  assert.throws(() => createNotificationWorker({}), TypeError);
});

test('notification worker reports dispatch failures through onError', async () => {
  const failures = [];
  const service = new NotificationService({ adapters: {}, scheduler: {} });
  const worker = createNotificationWorker(service, { onError: (error) => failures.push(error) });

  assert.equal(await worker.runOnce(), undefined);
  assert.equal(failures[0].code, 'NOTIFICATION_DISPATCH_NOT_SUPPORTED');

  const throwing = createNotificationWorker(service);
  await assert.rejects(() => throwing.runOnce(), { code: 'NOTIFICATION_DISPATCH_NOT_SUPPORTED' });
});

test('replays dead-lettered notifications back onto the schedule', async () => {
  const email = new MockChannelAdapter({ channel: CHANNELS.EMAIL, fail: true });
  const deadLetterStore = new InMemoryDeadLetterQueue();
  const service = new NotificationService({ adapters: { email }, maxScheduleAttempts: 1, deadLetterStore });

  await service.schedule({ id: 'replay-1', channels: [CHANNELS.EMAIL], body: 'hi' }, new Date('2026-01-01T00:00:00Z'));
  await service.dispatchScheduled({ now: new Date('2026-01-01T00:00:00Z') });
  assert.equal((await deadLetterStore.list()).length, 1);

  const replay = await replayDeadLetters({ service, store: deadLetterStore, when: new Date('2026-01-02T00:00:00Z') });
  assert.deepEqual(replay, { replayed: 1, notifications: ['replay-1'] });
  assert.equal((await service.listScheduled()).length, 1);
  assert.equal((await deadLetterStore.list()).length, 0);

  await assert.rejects(() => replayDeadLetters({ service: {}, store: deadLetterStore }), TypeError);
  await assert.rejects(() => replayDeadLetters({ service, store: {} }), TypeError);
});
