import assert from 'node:assert/strict';
import test from 'node:test';
import { CHANNELS, DELIVERY_STATUS, MockChannelAdapter, NotificationService, renderTemplate } from '../src/notifications/index.js';

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
