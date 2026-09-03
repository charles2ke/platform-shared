import { createAuthGuard } from '../src/auth/index.js';
import { CHANNELS, NotificationService } from '../src/notifications/index.js';

export function createWorkoutIntegration({ jwtSecret, adapters }) {
  return {
    requireWorkoutWrite: createAuthGuard({ secret: jwtSecret }),
    sendWorkoutNudge(user, workout) {
      return new NotificationService({ adapters }).send({
        channel: CHANNELS.PUSH,
        to: { userId: user.id },
        body: 'Time for {{name}}.',
        variables: workout
      });
    }
  };
}
