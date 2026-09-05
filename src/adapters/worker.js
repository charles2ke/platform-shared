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
  let dispatching = false;

  async function runOnce(now = new Date()) {
    if (dispatching) {
      logger.debug?.('Skipped notification dispatch because a run is still in progress');
      return undefined;
    }

    dispatching = true;
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
      dispatching = false;
    }
  }

  return {
    runOnce,
    /** True while a dispatch run is in flight. */
    isDispatching: () => dispatching,
    /** True once `start()` has scheduled the interval, until `stop()`. */
    isStarted: () => timer !== undefined,
    start() {
      if (timer !== undefined) {
        return timer;
      }
      // Interval-triggered runs never throw: failures go to `onError` when
      // configured, and are logged otherwise, so the loop keeps running.
      timer = setIntervalImpl(() => {
        void runOnce().catch(() => undefined);
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
 * Records that cannot be scheduled again are put back into the store instead of
 * being lost, and are reported as `failed`.
 *
 * @param {{service: object, store: object, when?: Date, principal?: object}} options
 * @returns {Promise<{replayed: number, notifications: string[], failed: object[]}>}
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
  const failed = [];
  for (const record of records) {
    try {
      await service.schedule(record.notification, when, { principal });
      notifications.push(record.notification?.id);
    } catch (error) {
      failed.push({ notification: record.notification, error: normalizeError(error, 'NOTIFICATION_REPLAY_FAILED') });
      await store.add(record);
    }
  }

  return { replayed: notifications.length, notifications, failed };
}
