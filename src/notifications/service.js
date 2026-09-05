import { toAccessPolicy } from '../auth/policy.js';
import { createError, normalizeError } from '../shared/errors.js';
import { noopLogger } from '../shared/logger.js';
import { renderTemplate } from './template.js';
import { CHANNELS, DELIVERY_STATUS } from './types.js';

export class NotificationService {
  #scheduled = [];

  constructor({ adapters = {}, logger = noopLogger, scheduler, maxScheduleAttempts = 3, retryDelayMs = 60_000, retryBackoffFactor = 1, maxRetryDelayMs, onDeadLetter, deadLetterStore, retryPartialFailures = true, policy, roleRegistry } = {}) {
    this.adapters = adapters;
    this.logger = logger;
    this.scheduler = scheduler;
    if (!Number.isInteger(maxScheduleAttempts) || maxScheduleAttempts < 1) {
      throw createError('NOTIFICATION_INVALID_MAX_ATTEMPTS', 'maxScheduleAttempts must be a positive integer', { status: 500 });
    }
    if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0) {
      throw createError('NOTIFICATION_INVALID_RETRY_DELAY', 'retryDelayMs must be a non-negative integer', { status: 500 });
    }
    if (!Number.isFinite(retryBackoffFactor) || retryBackoffFactor < 1) {
      throw createError('NOTIFICATION_INVALID_RETRY_BACKOFF', 'retryBackoffFactor must be a number greater than or equal to 1', { status: 500 });
    }
    if (maxRetryDelayMs !== undefined && (!Number.isInteger(maxRetryDelayMs) || maxRetryDelayMs < 0)) {
      throw createError('NOTIFICATION_INVALID_MAX_RETRY_DELAY', 'maxRetryDelayMs must be a non-negative integer', { status: 500 });
    }
    if (onDeadLetter !== undefined && typeof onDeadLetter !== 'function') {
      throw createError('NOTIFICATION_INVALID_DEAD_LETTER_HANDLER', 'onDeadLetter must be a function', { status: 500 });
    }
    if (deadLetterStore !== undefined && typeof deadLetterStore.add !== 'function') {
      throw createError('NOTIFICATION_INVALID_DEAD_LETTER_STORE', 'deadLetterStore must implement add()', { status: 500 });
    }
    this.maxScheduleAttempts = maxScheduleAttempts;
    this.retryDelayMs = retryDelayMs;
    this.retryBackoffFactor = retryBackoffFactor;
    this.maxRetryDelayMs = maxRetryDelayMs;
    this.onDeadLetter = onDeadLetter;
    this.deadLetterStore = deadLetterStore;
    this.retryPartialFailures = retryPartialFailures !== false;
    this.policy = toAccessPolicy(policy, { roleRegistry });
  }

  #enforce(action, { principal } = {}) {
    if (this.policy) {
      this.policy.enforce(action, principal);
    }
  }

  /** Delay in milliseconds before the retry that follows `attempts` failures. */
  retryDelayFor(attempts) {
    const normalizedAttempts = Number.isFinite(attempts) ? Math.max(1, Math.floor(attempts)) : 1;
    const exponent = normalizedAttempts - 1;
    const delay = Math.round(this.retryDelayMs * this.retryBackoffFactor ** exponent);
    return this.maxRetryDelayMs === undefined ? delay : Math.min(delay, this.maxRetryDelayMs);
  }

  async send(notification, options = {}) {
    this.#enforce('notification.send', options);
    const channels = normalizeChannels(notification);
    if (channels.length === 0) {
      throw createError('NOTIFICATION_CHANNEL_REQUIRED', 'At least one notification channel is required', { status: 400 });
    }

    const rendered = {
      ...notification,
      subject: notification.subject ? renderTemplate(notification.subject, notification.variables) : undefined,
      body: renderTemplate(notification.body ?? '', notification.variables)
    };

    const deliveries = [];
    for (const channel of channels) {
      const adapter = this.adapters[channel];
      if (!adapter) {
        deliveries.push({ channel, status: DELIVERY_STATUS.FAILED, error: createError('NOTIFICATION_ADAPTER_MISSING', `No adapter registered for ${channel}`, { status: 500 }).toJSON().error });
        continue;
      }

      try {
        deliveries.push(await adapter.send({ ...rendered, channel }));
      } catch (error) {
        const normalized = normalizeError(error, 'NOTIFICATION_DELIVERY_FAILED');
        this.logger.warn('Notification delivery failed', { channel, error: normalized });
        deliveries.push({ channel, status: DELIVERY_STATUS.FAILED, error: normalized.toJSON().error });
      }
    }

    const failedCount = deliveries.filter((delivery) => delivery.status === DELIVERY_STATUS.FAILED).length;
    return {
      notificationId: notification.id,
      status: failedCount === 0 ? DELIVERY_STATUS.SENT : failedCount === deliveries.length ? DELIVERY_STATUS.FAILED : DELIVERY_STATUS.PARTIAL,
      deliveries
    };
  }

  async schedule(notification, when, options = {}) {
    this.#enforce('notification.schedule', options);
    const scheduledFor = normalizeScheduleDate(when);

    if (this.scheduler) {
      if (typeof this.scheduler.enqueue !== 'function') {
        throw createError('NOTIFICATION_SCHEDULE_NOT_SUPPORTED', 'Injected scheduler must implement enqueue() for schedule()', { status: 500 });
      }
      await this.scheduler.enqueue(notification, scheduledFor);
    } else {
      this.#scheduled.push({ notification, scheduledFor: scheduledFor.toISOString(), attempts: 0 });
    }

    return {
      notificationId: notification.id,
      status: DELIVERY_STATUS.PENDING,
      scheduledFor: scheduledFor.toISOString(),
      notification
    };
  }

  /** Lists pending scheduled entries from the in-memory queue or injected scheduler. */
  async listScheduled(options = {}) {
    this.#enforce('notification.list', options);
    if (!this.scheduler) {
      return this.#scheduled.map((entry) => ({ ...entry }));
    }

    if (typeof this.scheduler.list !== 'function') {
      throw createError('NOTIFICATION_LIST_NOT_SUPPORTED', 'Injected scheduler must implement list() for listScheduled()', { status: 500 });
    }

    const entries = await this.scheduler.list();
    if (!Array.isArray(entries)) {
      throw createError('NOTIFICATION_INVALID_SCHEDULER_RESPONSE', 'scheduler.list() must return an array of scheduled entries', { status: 500 });
    }

    return entries.map((entry) => normalizeScheduledEntry(entry));
  }

  /**
   * Cancels every pending scheduled entry for a notification id, for example
   * when a trip is cancelled or a workout is completed early.
   * @returns {Promise<{notificationId: string, cancelled: number}>}
   */
  async cancelScheduled(notificationId, options = {}) {
    this.#enforce('notification.cancel', options);
    if (typeof notificationId !== 'string' || notificationId.length === 0) {
      throw createError('NOTIFICATION_INVALID_ID', 'A notification id is required to cancel scheduled deliveries', { status: 400 });
    }

    if (!this.scheduler) {
      const remaining = this.#scheduled.filter((entry) => entry.notification?.id !== notificationId);
      const cancelled = this.#scheduled.length - remaining.length;
      this.#scheduled = remaining;
      return { notificationId, cancelled };
    }

    if (typeof this.scheduler.cancel !== 'function') {
      throw createError('NOTIFICATION_CANCEL_NOT_SUPPORTED', 'Injected scheduler must implement cancel() for cancelScheduled()', { status: 500 });
    }

    const cancelled = await this.scheduler.cancel(notificationId);
    if (typeof cancelled === 'boolean') {
      return { notificationId, cancelled: cancelled ? 1 : 0 };
    }
    if (Number.isInteger(cancelled) && cancelled >= 0) {
      return { notificationId, cancelled };
    }
    throw createError('NOTIFICATION_INVALID_SCHEDULER_RESPONSE', 'scheduler.cancel() must return a boolean or a non-negative integer', { status: 500 });
  }

  async dispatchScheduled({ now = new Date(), principal } = {}) {
    this.#enforce('notification.dispatch', { principal });
    const nowDate = normalizeScheduleDate(now, { code: 'NOTIFICATION_INVALID_DISPATCH_TIME', message: 'Dispatch time must be a valid date value' });
    const dueEntries = await this.#loadDueEntries(nowDate);
    const results = [];
    const retryEntries = [];

    for (const entry of dueEntries) {
      try {
        const delivery = await this.send(entry.notification);
        const failedChannels = failedChannelsOf(delivery);
        const needsRetry = delivery.status === DELIVERY_STATUS.FAILED
          || (this.retryPartialFailures && delivery.status === DELIVERY_STATUS.PARTIAL && failedChannels.length > 0);
        const retry = needsRetry
          ? await this.#queueRetry(entry, retryEntries, nowDate, failedChannels)
          : undefined;
        results.push({
          notificationId: entry.notification.id,
          scheduledFor: entry.scheduledFor,
          attempts: (entry.attempts ?? 0) + 1,
          retryChannels: retry ? retry.notification.channels : undefined,
          retryScheduledFor: retry?.scheduledFor,
          deadLettered: needsRetry && retry === undefined,
          delivery
        });
      } catch (error) {
        const normalized = normalizeError(error, 'NOTIFICATION_DELIVERY_FAILED');
        this.logger.warn('Scheduled notification delivery failed', { notificationId: entry.notification.id, error: normalized });
        const retry = await this.#queueRetry(entry, retryEntries, nowDate);
        results.push({
          notificationId: entry.notification.id,
          scheduledFor: entry.scheduledFor,
          attempts: (entry.attempts ?? 0) + 1,
          retryScheduledFor: retry?.scheduledFor,
          deadLettered: retry === undefined,
          delivery: {
            notificationId: entry.notification.id,
            status: DELIVERY_STATUS.FAILED,
            deliveries: [{ status: DELIVERY_STATUS.FAILED, error: normalized.toJSON().error }]
          }
        });
      }
    }
    if (!this.scheduler && retryEntries.length > 0) {
      this.#scheduled.push(...retryEntries);
    }

    const pendingKnown = !this.scheduler || Boolean(this.scheduler.countPending);
    const pendingCount = this.scheduler
      ? (this.scheduler.countPending ? await this.scheduler.countPending(nowDate) : 0)
      : this.#scheduled.length;
    const status = aggregateDispatchStatus(results);
    return {
      status,
      processed: results.length,
      retried: results.filter((result) => result.retryScheduledFor !== undefined).length,
      deadLettered: results.filter((result) => result.deadLettered).length,
      pending: pendingCount,
      pendingKnown,
      results
    };
  }

  async #loadDueEntries(nowDate) {
    if (!this.scheduler) {
      const dueEntries = [];
      const pendingEntries = [];

      for (const entry of this.#scheduled) {
        if (new Date(entry.scheduledFor) <= nowDate) {
          dueEntries.push(entry);
        } else {
          pendingEntries.push(entry);
        }
      }

      this.#scheduled = pendingEntries;
      return dueEntries;
    }

    if (typeof this.scheduler.dequeueDue !== 'function') {
      throw createError('NOTIFICATION_DISPATCH_NOT_SUPPORTED', 'Injected scheduler must implement dequeueDue() for dispatchScheduled()', { status: 500 });
    }

    const dueEntries = await this.scheduler.dequeueDue(nowDate);
    if (!Array.isArray(dueEntries)) {
      throw createError('NOTIFICATION_INVALID_SCHEDULER_RESPONSE', 'scheduler.dequeueDue() must return an array of scheduled entries', { status: 500 });
    }

    return dueEntries.map((entry) => normalizeScheduledEntry(entry));
  }

  async #queueRetry(entry, retryEntries, nowDate, failedChannels = []) {
    const retryEntry = this.#buildRetryEntry(entry, nowDate, failedChannels);
    if (!retryEntry) {
      await this.#deadLetter(entry, 'retry-limit-reached', failedChannels);
      return undefined;
    }

    if (!this.scheduler) {
      retryEntries.push(retryEntry);
      return retryEntry;
    }

    if (typeof this.scheduler.requeue === 'function') {
      await this.scheduler.requeue(retryEntry.notification, new Date(retryEntry.scheduledFor), retryEntry.attempts);
      return retryEntry;
    }

    this.logger.warn('Scheduled notification retry skipped because injected scheduler does not implement requeue()', {
      notificationId: entry.notification?.id
    });
    await this.#deadLetter(entry, 'scheduler-requeue-unsupported', failedChannels);
    return undefined;
  }

  async #deadLetter(entry, reason, failedChannels = []) {
    const record = {
      notification: entry.notification,
      attempts: (entry.attempts ?? 0) + 1,
      reason,
      channels: failedChannels.length > 0 ? failedChannels : undefined,
      failedAt: new Date().toISOString()
    };

    if (this.deadLetterStore) {
      try {
        await this.deadLetterStore.add(record);
      } catch (error) {
        this.logger.warn('Notification dead-letter store failed', {
          notificationId: entry.notification?.id,
          error: normalizeError(error, 'NOTIFICATION_DEAD_LETTER_FAILED')
        });
      }
    }

    if (!this.onDeadLetter) {
      return;
    }

    try {
      await this.onDeadLetter(record);
    } catch (error) {
      this.logger.warn('Notification dead-letter handler failed', {
        notificationId: entry.notification?.id,
        error: normalizeError(error, 'NOTIFICATION_DEAD_LETTER_FAILED')
      });
    }
  }

  #buildRetryEntry(entry, nowDate, failedChannels = []) {
    const attempts = (entry.attempts ?? 0) + 1;
    if (attempts >= this.maxScheduleAttempts) {
      this.logger.warn('Scheduled notification retry limit reached', {
        notificationId: entry.notification?.id,
        maxScheduleAttempts: this.maxScheduleAttempts
      });
      return undefined;
    }

    return {
      ...entry,
      notification: retryNotification(entry.notification, failedChannels),
      attempts,
      scheduledFor: new Date(nowDate.getTime() + this.retryDelayFor(attempts)).toISOString()
    };
  }
}

/** Channels whose delivery failed, used to retry only what actually failed. */
function failedChannelsOf(delivery) {
  return (delivery?.deliveries ?? [])
    .filter((item) => item?.status === DELIVERY_STATUS.FAILED && typeof item.channel === 'string')
    .map((item) => item.channel);
}

/**
 * Narrows a retried notification to the channels that failed so already
 * delivered channels are not sent twice.
 */
function retryNotification(notification, failedChannels) {
  const channels = normalizeChannels(notification);
  if (failedChannels.length === 0 || failedChannels.length === channels.length) {
    return notification;
  }

  const retryChannels = channels.filter((channel) => failedChannels.includes(channel));
  if (retryChannels.length === 0) {
    return notification;
  }

  const { channel, ...rest } = notification;
  return { ...rest, channels: retryChannels };
}

function normalizeChannels(notification) {
  let channels;
  if (notification.channels === undefined) {
    channels = [notification.channel].filter(Boolean);
  } else if (typeof notification.channels === 'string') {
    channels = [notification.channels];
  } else if (Array.isArray(notification.channels)) {
    channels = notification.channels;
  } else {
    throw createError('NOTIFICATION_INVALID_CHANNELS', 'Notification channels must be a string or an array', { status: 400 });
  }

  for (const channel of channels) {
    if (typeof channel !== 'string' || !Object.values(CHANNELS).includes(channel)) {
      throw createError('NOTIFICATION_INVALID_CHANNEL', `Unsupported notification channel: ${String(channel)}`, { status: 400, details: { channel } });
    }
  }

  return [...new Set(channels)];
}

function normalizeScheduleDate(value, { code = 'NOTIFICATION_INVALID_SCHEDULE_TIME', message = 'Scheduled notification time must be a valid date value', status = 400 } = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw createError(code, message, { status });
  }

  return date;
}

function normalizeScheduledEntry(entry) {
  if (!entry || typeof entry !== 'object' || !Object.hasOwn(entry, 'notification')) {
    throw createError('NOTIFICATION_INVALID_SCHEDULER_RESPONSE', 'Scheduled entries must be objects with notification and scheduledFor (or when)', { status: 500 });
  }

  const notification = entry.notification;
  if (!notification || typeof notification !== 'object') {
    throw createError('NOTIFICATION_INVALID_SCHEDULER_RESPONSE', 'Scheduled entry must include a notification object', { status: 500 });
  }
  const rawScheduledFor = entry?.scheduledFor ?? entry?.when;
  if (rawScheduledFor === undefined) {
    throw createError('NOTIFICATION_INVALID_SCHEDULER_RESPONSE', 'Scheduled entry must include scheduledFor or when', { status: 500 });
  }

  return {
    notification,
    scheduledFor: normalizeScheduleDate(rawScheduledFor, {
      code: 'NOTIFICATION_INVALID_SCHEDULER_RESPONSE',
      message: 'Scheduled entry time must be a valid date value',
      status: 500
    }).toISOString(),
    attempts: Number.isInteger(entry?.attempts) && entry.attempts >= 0 ? entry.attempts : 0
  };
}

function aggregateDispatchStatus(results) {
  if (results.length === 0) {
    return DELIVERY_STATUS.PENDING;
  }

  const statuses = results.map((result) => result.delivery?.status);
  if (statuses.every((status) => status === DELIVERY_STATUS.SENT)) {
    return DELIVERY_STATUS.SENT;
  }
  if (statuses.every((status) => status === DELIVERY_STATUS.FAILED)) {
    return DELIVERY_STATUS.FAILED;
  }
  return DELIVERY_STATUS.PARTIAL;
}
