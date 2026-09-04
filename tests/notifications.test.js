import assert from 'node:assert/strict';
import test from 'node:test';
import { CHANNELS, ChannelAdapter, DELIVERY_STATUS, MockChannelAdapter, NotificationService, renderTemplate } from '../src/notifications/index.js';

test('renders notification template variables', () => {
  assert.equal(renderTemplate('Hello {{ user.name }}', { user: { name: 'Charles' } }), 'Hello Charles');
});

test('routes notifications to channel adapters', async () => {
  const email = new MockChannelAdapter({ channel: CHANNELS.EMAIL });
  const push = new MockChannelAdapter({ channel: CHANNELS.PUSH });
  const service = new NotificationService({ adapters: { email, push } });

  const result = await service.send({
    id: 'notification-1',
    channels: [CHANNELS.EMAIL, CHANNELS.PUSH],
    to: { email: 'user@example.com', userId: 'user-1' },
    subject: 'Welcome {{name}}',
    body: 'Hi {{name}}',
    variables: { name: 'Charles' }
  });

  assert.equal(result.status, DELIVERY_STATUS.SENT);
  assert.equal(email.deliveries[0].message.subject, 'Welcome Charles');
  assert.equal(push.deliveries.length, 1);
});

test('accepts a string channel and rejects invalid channel input', async () => {
  const email = new MockChannelAdapter({ channel: CHANNELS.EMAIL });
  const service = new NotificationService({ adapters: { email } });

  const result = await service.send({ id: 'notification-string-channel', channels: CHANNELS.EMAIL, body: 'Hello' });

  assert.equal(result.status, DELIVERY_STATUS.SENT);
  await assert.rejects(
    () => service.send({ id: 'notification-invalid-channels', channels: {} }),
    (error) => error.code === 'NOTIFICATION_INVALID_CHANNELS' && error.status === 400
  );
});

test('returns partial failure details without hiding successful deliveries', async () => {
  const email = new MockChannelAdapter({ channel: CHANNELS.EMAIL });
  const sms = new MockChannelAdapter({ channel: CHANNELS.SMS, fail: true });
  const service = new NotificationService({ adapters: { email, sms } });

  const result = await service.send({
    id: 'notification-2',
    channels: [CHANNELS.EMAIL, CHANNELS.SMS],
    to: { email: 'user@example.com', phone: '+15555555555' },
    body: 'Account update'
  });

  assert.equal(result.status, DELIVERY_STATUS.PARTIAL);
  assert.equal(result.deliveries.find((delivery) => delivery.channel === CHANNELS.EMAIL).status, DELIVERY_STATUS.SENT);
  assert.equal(result.deliveries.find((delivery) => delivery.channel === CHANNELS.SMS).error.code, 'NOTIFICATION_DELIVERY_FAILED');
});

test('returns placeholder schedule status for future delivery integration', async () => {
  const service = new NotificationService();
  const scheduled = await service.schedule({ id: 'notification-3', body: 'Later' }, new Date('2026-01-01T00:00:00Z'));

  assert.equal(scheduled.notificationId, 'notification-3');
  assert.equal(scheduled.status, DELIVERY_STATUS.PENDING);
  assert.equal(scheduled.scheduledFor, '2026-01-01T00:00:00.000Z');
  assert.equal(scheduled.notification.body, 'Later');
});

test('validates supported channels and de-duplicates channel delivery requests', async () => {
  const email = new MockChannelAdapter({ channel: CHANNELS.EMAIL });
  const service = new NotificationService({ adapters: { email } });
  const result = await service.send({
    id: 'notification-dup-channel',
    channels: [CHANNELS.EMAIL, CHANNELS.EMAIL],
    body: 'Hello'
  });

  assert.equal(result.status, DELIVERY_STATUS.SENT);
  assert.equal(email.deliveries.length, 1);

  await assert.rejects(
    () => service.send({ id: 'notification-invalid-channel', channels: ['fax'], body: 'Hello' }),
    (error) => error.code === 'NOTIFICATION_INVALID_CHANNEL' && error.status === 400
  );
});

test('dispatches due scheduled notifications via in-memory workflow', async () => {
  const email = new MockChannelAdapter({ channel: CHANNELS.EMAIL });
  const service = new NotificationService({ adapters: { email } });

  await service.schedule({ id: 'notification-4', channel: CHANNELS.EMAIL, body: 'Soon' }, '2026-01-01T00:00:00.000Z');
  await service.schedule({ id: 'notification-5', channel: CHANNELS.EMAIL, body: 'Later' }, '2026-02-01T00:00:00.000Z');

  const firstDispatch = await service.dispatchScheduled({ now: '2026-01-15T00:00:00.000Z' });
  assert.equal(firstDispatch.status, DELIVERY_STATUS.SENT);
  assert.equal(firstDispatch.processed, 1);
  assert.equal(firstDispatch.pending, 1);
  assert.equal(firstDispatch.results[0].notificationId, 'notification-4');
  assert.equal(firstDispatch.results[0].delivery.status, DELIVERY_STATUS.SENT);

  const secondDispatch = await service.dispatchScheduled({ now: '2026-03-01T00:00:00.000Z' });
  assert.equal(secondDispatch.status, DELIVERY_STATUS.SENT);
  assert.equal(secondDispatch.processed, 1);
  assert.equal(secondDispatch.pending, 0);
  assert.equal(secondDispatch.results[0].notificationId, 'notification-5');
  assert.equal(email.deliveries.length, 2);
});

test('requires dequeueDue when dispatching with an injected scheduler', async () => {
  const service = new NotificationService({ scheduler: { enqueue: async () => {}, countPending: async () => 0 } });
  await assert.rejects(
    () => service.dispatchScheduled({ now: '2026-01-15T00:00:00.000Z' }),
    (error) => error.code === 'NOTIFICATION_DISPATCH_NOT_SUPPORTED' && error.status === 500
  );
});

test('dispatches scheduler-provided entries and uses scheduler retry hooks', async () => {
  const sms = new MockChannelAdapter({ channel: CHANNELS.SMS, fail: true });
  const requeueCalls = [];
  const scheduler = {
    async dequeueDue() {
      return [{
        notification: { id: 'notification-scheduler', channel: CHANNELS.SMS, body: 'Retry via scheduler' },
        scheduledFor: '2026-01-01T00:00:00.000Z',
        attempts: 0
      }];
    },
    async countPending() {
      return 7;
    },
    async requeue(notification, when, attempts) {
      requeueCalls.push({ notification, when, attempts });
    }
  };
  const service = new NotificationService({ adapters: { sms }, scheduler, retryDelayMs: 0 });

  const result = await service.dispatchScheduled({ now: '2026-01-02T00:00:00.000Z' });
  assert.equal(result.status, DELIVERY_STATUS.FAILED);
  assert.equal(result.processed, 1);
  assert.equal(result.pending, 7);
  assert.equal(result.pendingKnown, true);
  assert.equal(requeueCalls.length, 1);
  assert.equal(requeueCalls[0].notification.id, 'notification-scheduler');
  assert.equal(requeueCalls[0].attempts, 1);
});

test('rejects invalid scheduler entry shapes', async () => {
  const scheduler = {
    async dequeueDue() {
      return [{ scheduledFor: '2026-01-01T00:00:00.000Z' }];
    }
  };
  const service = new NotificationService({ scheduler });

  await assert.rejects(
    () => service.dispatchScheduled({ now: '2026-01-02T00:00:00.000Z' }),
    (error) => error.code === 'NOTIFICATION_INVALID_SCHEDULER_RESPONSE' && error.status === 500
  );
});

test('re-queues failed in-memory scheduled deliveries for retry', async () => {
  const sms = new MockChannelAdapter({ channel: CHANNELS.SMS, fail: true });
  const service = new NotificationService({ adapters: { sms }, retryDelayMs: 0 });

  await service.schedule({ id: 'notification-retry', channel: CHANNELS.SMS, body: 'Retry me' }, '2026-01-01T00:00:00.000Z');
  const firstDispatch = await service.dispatchScheduled({ now: '2026-01-02T00:00:00.000Z' });
  assert.equal(firstDispatch.status, DELIVERY_STATUS.FAILED);
  assert.equal(firstDispatch.pending, 1);
  assert.equal(firstDispatch.results[0].notificationId, 'notification-retry');

  const secondDispatch = await service.dispatchScheduled({ now: '2026-01-03T00:00:00.000Z' });
  assert.equal(secondDispatch.processed, 1);
  assert.equal(secondDispatch.pending, 1);
  assert.equal(secondDispatch.results[0].notificationId, 'notification-retry');

  const thirdDispatch = await service.dispatchScheduled({ now: '2026-01-04T00:00:00.000Z' });
  assert.equal(thirdDispatch.processed, 1);
  assert.equal(thirdDispatch.pending, 0);
});

test('rejects invalid maxScheduleAttempts configuration', () => {
  assert.throws(
    () => new NotificationService({ maxScheduleAttempts: 0 }),
    (error) => error.code === 'NOTIFICATION_INVALID_MAX_ATTEMPTS' && error.status === 500
  );
});

test('rejects invalid retryDelayMs configuration', () => {
  assert.throws(
    () => new NotificationService({ retryDelayMs: -1 }),
    (error) => error.code === 'NOTIFICATION_INVALID_RETRY_DELAY' && error.status === 500
  );
});

test('exposes a channel adapter contract that requires implementations', async () => {
  const adapter = new ChannelAdapter({ channel: CHANNELS.SMS });
  assert.ok(new MockChannelAdapter({ channel: CHANNELS.SMS }) instanceof ChannelAdapter);
  await assert.rejects(() => adapter.send({ body: 'hi' }), { code: 'NOTIFICATION_ADAPTER_NOT_IMPLEMENTED' });
});
