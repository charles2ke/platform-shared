import { authorize, createAuthGuard, createRoleRegistry, InMemoryTokenRevocationStore } from '../src/auth/index.js';
import { CHANNELS, InMemoryDeadLetterQueue, InMemoryNotificationScheduler, NotificationService } from '../src/notifications/index.js';

const WORKOUT_ROLES = createRoleRegistry({
  athlete: ['workout:read', 'workout:write'],
  coach: { permissions: ['workout:assign'], inherits: ['athlete'] }
});

/**
 * Workout combines RBAC-protected routes with scheduled push reminders that
 * retry with exponential backoff and dead-letter after the attempt budget.
 */
export function createWorkoutIntegration({ jwtSecret, adapters, revocationStore = new InMemoryTokenRevocationStore(), deadLetters = [], deadLetterStore = new InMemoryDeadLetterQueue() }) {
  const scheduler = new InMemoryNotificationScheduler();
  const notifications = new NotificationService({
    adapters,
    scheduler,
    maxScheduleAttempts: 4,
    retryDelayMs: 30_000,
    retryBackoffFactor: 2,
    maxRetryDelayMs: 15 * 60_000,
    deadLetterStore,
    onDeadLetter: (entry) => deadLetters.push(entry)
  });
  const guard = createAuthGuard({ secret: jwtSecret, roleRegistry: WORKOUT_ROLES, revocationStore });

  return {
    scheduler,
    deadLetters,
    deadLetterStore,
    requireWorkoutWrite: (request) => guard(request, { permissions: ['workout:write'] }),
    assignWorkout(request, workout) {
      const principal = guard(request, { roles: ['coach'] });
      authorize(principal, { permissions: ['workout:assign'] });
      return { assignedBy: principal.id, workout };
    },
    scheduleWorkoutNudge(user, workout, when) {
      return notifications.schedule({
        id: `workout-${workout.id}`,
        channel: CHANNELS.PUSH,
        to: { userId: user.id },
        body: 'Time for {{name}}.',
        variables: workout
      }, when);
    },
    // Coaches inherit the athlete role, so inherited role checks work too.
    requireAthlete: (request) => guard(request, { roles: ['athlete'] }),
    cancelWorkoutNudge: (workout) => notifications.cancelScheduled(`workout-${workout.id}`),
    dispatchDueNudges: (now = new Date()) => notifications.dispatchScheduled({ now })
  };
}
