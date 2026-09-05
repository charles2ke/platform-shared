import { CHANNELS, InMemoryDeadLetterQueue, InMemoryNotificationScheduler, NotificationService } from '../src/notifications/index.js';
import { createNotificationWorker, replayDeadLetters } from '../src/adapters/index.js';

/**
 * Travel schedules trip reminders ahead of departure and drains them from a
 * cron/worker loop through `dispatchDueReminders()`.
 */
export function createTravelNotifications({ adapters, scheduler = new InMemoryNotificationScheduler(), logger, deadLetterStore = new InMemoryDeadLetterQueue() }) {
  const notifications = new NotificationService({
    adapters,
    scheduler,
    logger,
    maxScheduleAttempts: 3,
    retryDelayMs: 5 * 60_000,
    retryBackoffFactor: 3,
    deadLetterStore
  });

  // Long-running worker process: worker.start() / worker.stop().
  const worker = createNotificationWorker(notifications, { intervalMs: 60_000, logger });

  return {
    scheduler,
    worker,
    deadLetterStore,
    sendTripReminder: (traveler, trip) => notifications.send(buildReminder(traveler, trip)),
    scheduleTripReminder: (traveler, trip, when) => notifications.schedule(buildReminder(traveler, trip), when),
    dispatchDueReminders: (now = new Date()) => notifications.dispatchScheduled({ now }),
    // Trip cancelled or rebooked: drop any reminders still waiting in the queue.
    cancelTripReminder: (trip) => notifications.cancelScheduled(`trip-${trip.id}`),
    listPendingReminders: () => notifications.listScheduled(),
    // Provider outage recovery: put dead-lettered reminders back on the queue.
    replayFailedReminders: (when = new Date()) => replayDeadLetters({ service: notifications, store: deadLetterStore, when })
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
