import { ProfileService } from '../src/profile/index.js';
import { CHANNELS, NotificationService } from '../src/notifications/index.js';

export function createBasaIntegration({ profileStore, adapters }) {
  return {
    profiles: new ProfileService({ store: profileStore }),
    sendOrderUpdate(order) {
      return new NotificationService({ adapters }).send({
        channels: [CHANNELS.EMAIL, CHANNELS.SMS],
        to: { email: order.email, phone: order.phone },
        subject: 'Order {{id}} update',
        body: 'Your order status is {{status}}.',
        variables: order
      });
    }
  };
}
