import { createError } from '../shared/errors.js';

function notImplemented(method) {
  throw createError('NOTIFICATION_SCHEDULER_NOT_IMPLEMENTED', `NotificationScheduler.${method}() must be implemented`, { status: 500 });
}

/**
 * Contract for notification schedulers. Downstream apps back this with a real
 * queue (SQS, BullMQ, cron table) and pass the instance to `NotificationService`.
 */
export class NotificationScheduler {
  async enqueue(notification, scheduledFor) {
    return notImplemented('enqueue');
  }

  async dequeueDue(now) {
    return notImplemented('dequeueDue');
  }

  async requeue(notification, scheduledFor, attempts) {
    return notImplemented('requeue');
  }

  async countPending(now) {
    return notImplemented('countPending');
  }

  async list() {
    return notImplemented('list');
  }
}

/**
 * Reference scheduler used by tests, local development, and as a template for
 * queue-backed implementations. Entries are `{ notification, scheduledFor, attempts }`.
 */
export class InMemoryNotificationScheduler extends NotificationScheduler {
  #entries = [];

  async enqueue(notification, scheduledFor, attempts = 0) {
    const entry = {
      notification,
      scheduledFor: normalizeDate(scheduledFor).toISOString(),
      attempts: Number.isInteger(attempts) && attempts >= 0 ? attempts : 0
    };
    this.#entries.push(entry);
    return { ...entry };
  }

  async dequeueDue(now = new Date()) {
    const nowDate = normalizeDate(now);
    const due = [];
    const pending = [];
    for (const entry of this.#entries) {
      if (new Date(entry.scheduledFor) <= nowDate) {
        due.push(entry);
      } else {
        pending.push(entry);
      }
    }

    this.#entries = pending;
    return due.map((entry) => ({ ...entry }));
  }

  async requeue(notification, scheduledFor, attempts) {
    return this.enqueue(notification, scheduledFor, attempts);
  }

  async countPending() {
    return this.#entries.length;
  }

  /** Returns a copy of pending entries, useful for assertions and dashboards. */
  async list() {
    return this.#entries.map((entry) => ({ ...entry }));
  }
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw createError('NOTIFICATION_INVALID_SCHEDULE_TIME', 'Scheduled notification time must be a valid date value', { status: 400 });
  }

  return date;
}
