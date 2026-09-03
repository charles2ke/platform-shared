import { DELIVERY_STATUS } from './types.js';

export class MockChannelAdapter {
  constructor({ channel, fail = false } = {}) {
    this.channel = channel;
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
