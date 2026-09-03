import { createError, normalizeError } from '../shared/errors.js';
import { noopLogger } from '../shared/logger.js';
import { renderTemplate } from './template.js';
import { DELIVERY_STATUS } from './types.js';

export class NotificationService {
  constructor({ adapters = {}, logger = noopLogger } = {}) {
    this.adapters = adapters;
    this.logger = logger;
  }

  async send(notification) {
    const channels = notification.channels ?? [notification.channel].filter(Boolean);
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
    return {
      notificationId: notification.id,
      status: DELIVERY_STATUS.PENDING,
      scheduledFor: when instanceof Date ? when.toISOString() : when,
      notification
    };
  }
}
