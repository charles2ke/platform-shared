import { createError } from '../shared/errors.js';
import { DELIVERY_STATUS } from './types.js';

/**
 * Contract for notification channel adapters. Downstream apps extend this class
 * (or provide an object with a `send()` method) to plug real providers in.
 */
export class ChannelAdapter {
  constructor({ channel } = {}) {
    this.channel = channel;
  }

  async send(message) {
    throw createError('NOTIFICATION_ADAPTER_NOT_IMPLEMENTED', `ChannelAdapter.send() must be implemented for ${this.channel ?? 'unknown'}`, { status: 500 });
  }
}

export class MockChannelAdapter extends ChannelAdapter {
  constructor({ channel, fail = false } = {}) {
    super({ channel });
    this.fail = fail;
    this.deliveries = [];
  }

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
