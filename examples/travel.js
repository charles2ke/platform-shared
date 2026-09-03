import { CHANNELS, NotificationService } from '../src/notifications/index.js';

export async function sendTripReminder({ adapters, traveler, trip }) {
  const notifications = new NotificationService({ adapters });
  return notifications.send({
    channels: [CHANNELS.EMAIL, CHANNELS.PUSH],
    to: { email: traveler.email, userId: traveler.id },
    subject: 'Upcoming trip to {{destination}}',
    body: 'Your {{destination}} trip starts on {{startsAt}}.',
    variables: trip
  });
}
