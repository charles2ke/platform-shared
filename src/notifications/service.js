import { createError, normalizeError } from '../shared/errors.js';
import { noopLogger } from '../shared/logger.js';
import { renderTemplate } from './template.js';
import { CHANNELS, DELIVERY_STATUS } from './types.js';

export class NotificationService {
  #scheduled = [];

  constructor({ adapters = {}, logger = noopLogger, scheduler, maxScheduleAttempts = 3, retryDelayMs = 60_000 } = {}) {
    this.adapters = adapters;
    this.logger = logger;
    this.scheduler = scheduler;
    if (!Number.isInteger(maxScheduleAttempts) || maxScheduleAttempts < 1) {
      throw createError('NOTIFICATION_INVALID_MAX_ATTEMPTS', 'maxScheduleAttempts must be a positive integer', { status: 500 });
    }
    if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0) {
      throw createError('NOTIFICATION_INVALID_RETRY_DELAY', 'retryDelayMs must be a non-negative integer', { status: 500 });
    }
    this.maxScheduleAttempts = maxScheduleAttempts;
    this.retryDelayMs = retryDelayMs;
  }

  async send(notification) {
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

  async schedule(notification, when) {
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

  async dispatchScheduled({ now = new Date() } = {}) {
    const nowDate = normalizeScheduleDate(now, { code: 'NOTIFICATION_INVALID_DISPATCH_TIME', message: 'Dispatch time must be a valid date value' });
    const dueEntries = await this.#loadDueEntries(nowDate);
    const results = [];
    const retryEntries = [];

    for (const entry of dueEntries) {
      try {
        const delivery = await this.send(entry.notification);
        if (delivery.status === DELIVERY_STATUS.FAILED) {
          await this.#queueRetry(entry, retryEntries, nowDate);
        }
        results.push({
          notificationId: entry.notification.id,
          scheduledFor: entry.scheduledFor,
          delivery
        });
      } catch (error) {
        const normalized = normalizeError(error, 'NOTIFICATION_DELIVERY_FAILED');
        this.logger.warn('Scheduled notification delivery failed', { notificationId: entry.notification.id, error: normalized });
        await this.#queueRetry(entry, retryEntries, nowDate);
        results.push({
          notificationId: entry.notification.id,
          scheduledFor: entry.scheduledFor,
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

  async #queueRetry(entry, retryEntries, nowDate) {
    const retryEntry = this.#buildRetryEntry(entry, nowDate);
    if (!retryEntry) {
      return;
    }

    if (!this.scheduler) {
      retryEntries.push(retryEntry);
      return;
    }

    if (typeof this.scheduler.requeue === 'function') {
      await this.scheduler.requeue(retryEntry.notification, new Date(retryEntry.scheduledFor), retryEntry.attempts);
      return;
    }

    this.logger.warn('Scheduled notification retry skipped because injected scheduler does not implement requeue()', {
      notificationId: entry.notification?.id
    });
  }

  #buildRetryEntry(entry, nowDate) {
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
      attempts,
      scheduledFor: new Date(nowDate.getTime() + this.retryDelayMs).toISOString()
    };
  }
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
