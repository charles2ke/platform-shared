import { createError, normalizeError } from '../shared/errors.js';
import { noopLogger } from '../shared/logger.js';
import { renderTemplate } from './template.js';
import { CHANNELS, DELIVERY_STATUS } from './types.js';

export class NotificationService {
  #scheduled = [];

  constructor({ adapters = {}, logger = noopLogger, scheduler } = {}) {
    this.adapters = adapters;
    this.logger = logger;
    this.scheduler = scheduler;
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

    if (this.scheduler?.enqueue) {
      await this.scheduler.enqueue(notification, scheduledFor);
    } else {
      this.#scheduled.push({ notification, scheduledFor: scheduledFor.toISOString() });
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

    for (const entry of dueEntries) {
      try {
        results.push({
          notificationId: entry.notification.id,
          scheduledFor: entry.scheduledFor,
          delivery: await this.send(entry.notification)
        });
      } catch (error) {
        const normalized = normalizeError(error, 'NOTIFICATION_DELIVERY_FAILED');
        this.logger.warn('Scheduled notification delivery failed', { notificationId: entry.notification.id, error: normalized });
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

    const pendingCount = this.scheduler?.countPending
      ? await this.scheduler.countPending(nowDate)
      : this.#scheduled.length;
    const status = aggregateDispatchStatus(results);
    return {
      status,
      processed: results.length,
      pending: pendingCount,
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

  const normalized = [...new Set(channels)];
  for (const channel of normalized) {
    if (typeof channel !== 'string' || !Object.values(CHANNELS).includes(channel)) {
      throw createError('NOTIFICATION_INVALID_CHANNEL', `Unsupported notification channel: ${String(channel)}`, { status: 400, details: { channel } });
    }
  }

  return normalized;
}

function normalizeScheduleDate(value, { code = 'NOTIFICATION_INVALID_SCHEDULE_TIME', message = 'Scheduled notification time must be a valid date value' } = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw createError(code, message, { status: 400 });
  }

  return date;
}

function normalizeScheduledEntry(entry) {
  const notification = entry?.notification ?? entry;
  return {
    notification,
    scheduledFor: normalizeScheduleDate(entry?.scheduledFor ?? entry?.when ?? new Date()).toISOString()
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
