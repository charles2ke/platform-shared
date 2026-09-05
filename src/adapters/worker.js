import { normalizeError } from '../shared/errors.js';
import { noopLogger } from '../shared/logger.js';

/**
 * Cron/worker loop that drains scheduled notifications through
 * `NotificationService.dispatchScheduled()`. Downstream repos can run
 * `runOnce()` from an existing cron/queue trigger, or `start()` in a
 * long-running worker process.
 *
 * @param {object} service A `NotificationService` instance.
 * @param {{intervalMs?: number, logger?: object, principal?: object, onError?: Function, setIntervalImpl?: Function, clearIntervalImpl?: Function}} [options]
 */
export function createNotificationWorker(service, {
  intervalMs = 60_000,
  logger = noopLogger,
  principal,
  onError,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval
} = {}) {
  if (!service || typeof service.dispatchScheduled !== 'function') {
    throw new TypeError('service must be a NotificationService with dispatchScheduled()');
  }

  let timer;
  let running = false;

  async function runOnce(now = new Date()) {
    if (running) {
      return undefined;
    }

    running = true;
    try {
      const summary = await service.dispatchScheduled({ now, principal });
      logger.debug?.('Dispatched scheduled notifications', summary);
      return summary;
    } catch (error) {
      const normalized = normalizeError(error, 'NOTIFICATION_WORKER_FAILED');
      logger.error?.('Notification worker run failed', { error: normalized });
      if (typeof onError === 'function') {
        onError(normalized);
        return undefined;
      }
      throw normalized;
    } finally {
      running = false;
    }
  }

  return {
    runOnce,
    isRunning: () => timer !== undefined,
    start() {
      if (timer !== undefined) {
        return timer;
      }
      timer = setIntervalImpl(() => {
        void runOnce().catch((error) => logger.error?.('Notification worker run failed', { error: normalizeError(error) }));
      }, intervalMs);
      timer.unref?.();
      return timer;
    },
    stop() {
      if (timer !== undefined) {
        clearIntervalImpl(timer);
        timer = undefined;
      }
    }
  };
}

/**
 * Re-queues dead-lettered notifications so operators can replay failures after
 * a provider outage is fixed. Records are drained from the store and scheduled
 * again through the service.
 *
 * @param {{service: object, store: object, when?: Date, principal?: object}} options
 * @returns {Promise<{replayed: number, notifications: string[]}>}
 */
export async function replayDeadLetters({ service, store, when = new Date(), principal } = {}) {
  if (!service || typeof service.schedule !== 'function') {
    throw new TypeError('service must be a NotificationService with schedule()');
  }
  if (!store || typeof store.drain !== 'function') {
    throw new TypeError('store must implement drain()');
  }

  const records = await store.drain();
  const notifications = [];
  for (const record of records) {
    await service.schedule(record.notification, when, { principal });
    notifications.push(record.notification?.id);
  }

  return { replayed: notifications.length, notifications };
}
