import { CHANNELS, InMemoryNotificationScheduler, NotificationService } from '../src/notifications/index.js';

/**
 * Travel schedules trip reminders ahead of departure and drains them from a
 * cron/worker loop through `dispatchDueReminders()`.
 */
export function createTravelNotifications({ adapters, scheduler = new InMemoryNotificationScheduler(), logger }) {
  const notifications = new NotificationService({
    adapters,
    scheduler,
    logger,
    maxScheduleAttempts: 3,
    retryDelayMs: 5 * 60_000,
    retryBackoffFactor: 3
  });

  return {
    scheduler,
    sendTripReminder: (traveler, trip) => notifications.send(buildReminder(traveler, trip)),
    scheduleTripReminder: (traveler, trip, when) => notifications.schedule(buildReminder(traveler, trip), when),
    dispatchDueReminders: (now = new Date()) => notifications.dispatchScheduled({ now })
  };
}

export async function sendTripReminder({ adapters, traveler, trip }) {
  return new NotificationService({ adapters }).send(buildReminder(traveler, trip));
}

function buildReminder(traveler, trip) {
  return {
    id: `trip-${trip.id}`,
    channels: [CHANNELS.EMAIL, CHANNELS.PUSH],
    to: { email: traveler.email, userId: traveler.id },
    subject: 'Upcoming trip to {{destination}}',
    body: 'Your {{destination}} trip starts on {{startsAt}}.',
    variables: trip
  };
}
