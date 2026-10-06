import { createError } from '../shared/errors.js';
import { DELIVERY_STATUS } from './types.js';

/**
 * @typedef {{id?: string, channel?: string, channels?: any, subject?: string, body?: string, variables?: Record<string, any>, quietHours?: object, bypassQuietHours?: boolean, strategy?: string, [key: string]: any}} NotificationMessage
 * @typedef {{channel?: string, providerMessageId?: string, status: string, sentAt?: string, message?: NotificationMessage, error?: any}} ChannelDelivery
 */

/**
 * Contract for notification channel adapters. Downstream apps extend this class
 * (or provide an object with a `send()` method) to plug real providers in.
 */
export class ChannelAdapter {
  /** @param {{channel?: string}} [options] */
  constructor({ channel } = {}) {
    this.channel = channel;
  }

  /**
   * @param {NotificationMessage} message
   * @returns {Promise<ChannelDelivery>}
   */
  async send(message) {
    throw createError('NOTIFICATION_ADAPTER_NOT_IMPLEMENTED', `ChannelAdapter.send() must be implemented for ${this.channel ?? 'unknown'}`, { status: 500 });
  }
}

export class MockChannelAdapter extends ChannelAdapter {
  /** @param {{channel?: string, fail?: boolean}} [options] */
  constructor({ channel, fail = false } = {}) {
    super({ channel });
    this.fail = fail;
    this.deliveries = [];
  }

  /**
   * @param {NotificationMessage} message
   * @returns {Promise<ChannelDelivery>}
   */
  async send(message) {
    if (this.fail) {
      throw new Error(`${this.channel} provider failed`);
    }

    const delivery = {
      channel: this.channel,
      providerMessageId: `${this.channel}-${this.deliveries.length + 1}`,
      status: DELIVERY_STATUS.SENT,
      sentAt: new Date().toISOString(),
      message
    };
    this.deliveries.push(delivery);
    return delivery;
  }
}
