import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyToken } from '../src/auth/index.js';
import { CHANNELS, DELIVERY_STATUS, MockChannelAdapter } from '../src/notifications/index.js';
import { createBasaIntegration } from '../examples/basa.js';
import { createSocialPlatform } from '../examples/social.js';
import { createTravelNotifications } from '../examples/travel.js';
import { createWorkoutIntegration } from '../examples/workout.js';

const jwtSecret = 'example-secret-that-is-long-enough-abc';

function bearer(token) {
  return { headers: { authorization: 'Bearer ' + token } };
}

test('social example issues, guards, rotates, and revokes tokens', () => {
  const social = createSocialPlatform({ jwtSecret });
  const tokens = social.login({ id: 'user-1', roles: ['moderator'] });

  assert.equal(social.requireMember(bearer(tokens.accessToken)).id, 'user-1');
  assert.equal(social.requireModerator(bearer(tokens.accessToken)).id, 'user-1');

  const rotated = social.refresh(tokens.refreshToken);
  assert.equal(social.requireMember(bearer(rotated.accessToken)).id, 'user-1');

  social.logout(verifyToken(rotated.accessToken, { secret: jwtSecret, issuer: 'platform-shared', audience: 'social' }));
  assert.throws(() => social.requireMember(bearer(rotated.accessToken)), { code: 'AUTH_TOKEN_REVOKED' });
});

test('workout example enforces role permissions and dispatches scheduled nudges', async () => {
  const push = new MockChannelAdapter({ channel: CHANNELS.PUSH });
  const workout = createWorkoutIntegration({ jwtSecret, adapters: { push } });
  const social = createSocialPlatform({ jwtSecret });
  const coachToken = social.login({ id: 'coach-1', roles: ['coach'] }).accessToken;

  assert.equal(workout.requireWorkoutWrite(bearer(coachToken)).id, 'coach-1');
  assert.deepEqual(workout.assignWorkout(bearer(coachToken), { id: 'w-1' }), { assignedBy: 'coach-1', workout: { id: 'w-1' } });

  const when = new Date('2026-02-01T00:00:00Z');
  await workout.scheduleWorkoutNudge({ id: 'user-1' }, { id: 'w-1', name: 'Legs' }, when);
  const dispatched = await workout.dispatchDueNudges(when);

  assert.equal(dispatched.status, DELIVERY_STATUS.SENT);
  assert.equal(await workout.scheduler.countPending(), 0);
  assert.equal(push.deliveries[0].message.body, 'Time for Legs.');
});

test('travel example schedules and dispatches trip reminders', async () => {
  const email = new MockChannelAdapter({ channel: CHANNELS.EMAIL });
  const pushAdapter = new MockChannelAdapter({ channel: CHANNELS.PUSH });
  const travel = createTravelNotifications({ adapters: { email, push: pushAdapter } });
  const when = new Date('2026-03-01T00:00:00Z');

  await travel.scheduleTripReminder({ id: 'user-1', email: 'user@example.com' }, { id: 't-1', destination: 'Nairobi', startsAt: 'Monday' }, when);
  const dispatched = await travel.dispatchDueReminders(when);

  assert.equal(dispatched.status, DELIVERY_STATUS.SENT);
  assert.equal(email.deliveries[0].message.subject, 'Upcoming trip to Nairobi');
});

test('basa example guards refunds and schedules order updates', async () => {
  const email = new MockChannelAdapter({ channel: CHANNELS.EMAIL });
  const sms = new MockChannelAdapter({ channel: CHANNELS.SMS });
  const basa = createBasaIntegration({ jwtSecret, adapters: { email, sms } });
  const social = createSocialPlatform({ jwtSecret });
  const customerToken = social.login({ id: 'customer-1', roles: ['customer'] }).accessToken;
  const supportToken = social.login({ id: 'support-1', roles: ['support'] }).accessToken;

  assert.equal(basa.requireOrderRead(bearer(customerToken)).id, 'customer-1');
  assert.throws(() => basa.requireRefund(bearer(customerToken)), { code: 'AUTH_FORBIDDEN' });
  assert.equal(basa.requireRefund(bearer(supportToken)).id, 'support-1');

  const profile = await basa.createCustomerProfile(bearer(supportToken), { displayName: 'Customer One', contact: { email: 'customer@example.com' } });
  assert.equal((await basa.readCustomerProfile(bearer(supportToken), profile.id)).displayName, 'Customer One');
  // Profile RBAC is enforced inside the service, not only on the route.
  await assert.rejects(
    () => basa.createCustomerProfile(bearer(customerToken), { displayName: 'Nope', contact: { email: 'nope@example.com' } }),
    { code: 'AUTH_FORBIDDEN' }
  );

  const when = new Date('2026-04-01T00:00:00Z');
  await basa.scheduleOrderUpdate({ id: 'o-1', email: 'customer@example.com', phone: '+254700000000', status: 'shipped' }, when);
  const dispatched = await basa.dispatchDueOrderUpdates(when);

  assert.equal(dispatched.status, DELIVERY_STATUS.SENT);
  assert.equal(sms.deliveries[0].message.body, 'Your order status is shipped.');
});

test('social example ends a whole session on logout and replays dead-lettered reminders', async () => {
  const social = createSocialPlatform({ jwtSecret });
  const tokens = social.login({ id: 'user-4', roles: ['member'] });
  const claims = social.session(tokens.accessToken);

  assert.equal(claims.sessionId, tokens.sessionId);
  social.logoutSession(verifyToken(tokens.accessToken, { secret: jwtSecret, issuer: 'platform-shared', audience: 'social' }));
  assert.throws(() => social.requireMember(bearer(tokens.accessToken)), { code: 'AUTH_TOKEN_REVOKED' });
  assert.throws(() => social.refresh(tokens.refreshToken), { code: 'AUTH_REFRESH_TOKEN_REUSED' });

  const email = new MockChannelAdapter({ channel: CHANNELS.EMAIL, fail: true });
  const push = new MockChannelAdapter({ channel: CHANNELS.PUSH, fail: true });
  const travel = createTravelNotifications({ adapters: { email, push } });
  const when = new Date('2026-08-01T00:00:00Z');

  await travel.scheduleTripReminder({ id: 'user-4', email: 'user@example.com' }, { id: 't-3', destination: 'Kisumu', startsAt: 'Sunday' }, when);
  let attempt = when;
  for (let index = 0; index < 3; index += 1) {
    attempt = new Date(attempt.getTime() + 60 * 60_000);
    await travel.worker.runOnce(attempt);
  }

  assert.equal((await travel.deadLetterStore.list()).length, 1);
  assert.deepEqual(await travel.replayFailedReminders(attempt), { replayed: 1, notifications: ['trip-t-3'] });
  assert.deepEqual((await travel.listPendingReminders()).map((entry) => entry.notification.id), ['trip-t-3']);
});

test('social example reports sessions and blocks refresh token replay', () => {
  const social = createSocialPlatform({ jwtSecret });
  const tokens = social.login({ id: 'user-2', roles: ['member'] });
  const session = social.session(tokens.accessToken);

  assert.equal(session.subject, 'user-2');
  assert.equal(session.tokenUse, 'access');
  assert.equal(session.expired, false);

  const rotated = social.refresh(tokens.refreshToken);
  assert.throws(() => social.refresh(tokens.refreshToken), { code: 'AUTH_REFRESH_TOKEN_REUSED' });
  assert.deepEqual(social.reuseEvents.map((event) => event.subject), ['user-2']);
  assert.throws(() => social.requireMember(bearer(rotated.accessToken)), { code: 'AUTH_TOKEN_REVOKED' });
});

test('workout example honors inherited roles and cancels queued nudges', async () => {
  const push = new MockChannelAdapter({ channel: CHANNELS.PUSH });
  const workout = createWorkoutIntegration({ jwtSecret, adapters: { push } });
  const coachToken = createSocialPlatform({ jwtSecret }).login({ id: 'coach-2', roles: ['coach'] }).accessToken;

  assert.equal(workout.requireAthlete(bearer(coachToken)).id, 'coach-2');

  const when = new Date('2026-06-01T00:00:00Z');
  await workout.scheduleWorkoutNudge({ id: 'user-2' }, { id: 'w-2', name: 'Core' }, when);
  assert.deepEqual(await workout.cancelWorkoutNudge({ id: 'w-2' }), { notificationId: 'workout-w-2', cancelled: 1 });
  assert.equal((await workout.dispatchDueNudges(when)).processed, 0);
  assert.equal(push.deliveries.length, 0);
});

test('travel and basa examples expose pending queues and cancellation', async () => {
  const email = new MockChannelAdapter({ channel: CHANNELS.EMAIL });
  const sms = new MockChannelAdapter({ channel: CHANNELS.SMS });
  const push = new MockChannelAdapter({ channel: CHANNELS.PUSH });
  const travel = createTravelNotifications({ adapters: { email, push } });
  const basa = createBasaIntegration({ jwtSecret, adapters: { email, sms } });
  const when = new Date('2026-07-01T00:00:00Z');

  await travel.scheduleTripReminder({ id: 'user-3', email: 'user@example.com' }, { id: 't-2', destination: 'Mombasa', startsAt: 'Friday' }, when);
  assert.deepEqual((await travel.listPendingReminders()).map((entry) => entry.notification.id), ['trip-t-2']);
  assert.deepEqual(await travel.cancelTripReminder({ id: 't-2' }), { notificationId: 'trip-t-2', cancelled: 1 });
  assert.deepEqual(await travel.listPendingReminders(), []);

  await basa.scheduleOrderUpdate({ id: 'o-2', email: 'customer@example.com', phone: '+254700000001', status: 'delayed' }, when);
  assert.deepEqual((await basa.pendingOrderUpdates()).map((entry) => entry.notification.id), ['order-o-2']);
  assert.deepEqual(await basa.cancelOrderUpdate({ id: 'o-2' }), { notificationId: 'order-o-2', cancelled: 1 });
  assert.equal((await basa.dispatchDueOrderUpdates(when)).processed, 0);
});
