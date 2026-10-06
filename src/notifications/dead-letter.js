import { createError } from '../shared/errors.js';

/**
 * @typedef {{notification?: {id?: string, [key: string]: any}, attempts?: number, reason?: string, channels?: string[], failedAt?: string, [key: string]: any}} DeadLetterRecord
 */

function notImplemented(method) {
  throw createError('NOTIFICATION_DEAD_LETTER_STORE_NOT_IMPLEMENTED', `DeadLetterStore.${method}() must be implemented`, { status: 500 });
}

/**
 * Contract for dead-letter stores. `NotificationService` writes a record here
 * whenever a scheduled notification exhausts its retries, so downstream apps
 * can inspect, alert on, and replay failures instead of losing them.
 * Records are `{ notification, attempts, reason, channels?, failedAt }`.
 */
export class DeadLetterStore {
  /** @param {DeadLetterRecord} record @returns {Promise<DeadLetterRecord>} */
  async add(record) {
    return notImplemented('add');
  }

  /** @param {{limit?: number}} [options] @returns {Promise<DeadLetterRecord[]>} */
  async list(options) {
    return notImplemented('list');
  }

  /** @param {string} notificationId @returns {Promise<number>} */
  async remove(notificationId) {
    return notImplemented('remove');
  }

  /** @param {{limit?: number}} [options] @returns {Promise<DeadLetterRecord[]>} */
  async drain(options) {
    return notImplemented('drain');
  }
}

/** Reference dead-letter store for tests, local development, and replay demos. */
export class InMemoryDeadLetterQueue extends DeadLetterStore {
  #records = [];

  /** @param {DeadLetterRecord} record @returns {Promise<DeadLetterRecord>} */
  async add(record) {
    if (!record || typeof record !== 'object' || !record.notification) {
      throw createError('NOTIFICATION_INVALID_DEAD_LETTER_RECORD', 'Dead-letter records must include a notification', { status: 500 });
    }

    const stored = { ...record, failedAt: record.failedAt ?? new Date().toISOString() };
    this.#records.push(stored);
    return { ...stored };
  }

  /** @param {{limit?: number}} [options] @returns {Promise<DeadLetterRecord[]>} */
  async list(options) {
    return this.#records.map((record) => ({ ...record }));
  }

  async size() {
    return this.#records.length;
  }

  /**
   * Removes every record for a notification id.
   * @returns {Promise<number>} How many records were removed.
   */
  async remove(notificationId) {
    const remaining = this.#records.filter((record) => record.notification?.id !== notificationId);
    const removed = this.#records.length - remaining.length;
    this.#records = remaining;
    return removed;
  }

  /** Returns and clears every record, for replay through `NotificationService`. */
  /** @param {{limit?: number}} [options] @returns {Promise<DeadLetterRecord[]>} */
  async drain(options) {
    const records = this.#records.map((record) => ({ ...record }));
    this.#records = [];
    return records;
  }
}
