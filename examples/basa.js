import { createAccessPolicy, createAuthGuard, createRoleRegistry, InMemoryTokenRevocationStore } from '../src/auth/index.js';
import { CHANNELS, InMemoryNotificationScheduler, NotificationService } from '../src/notifications/index.js';
import { ProfileService } from '../src/profile/index.js';

const BASA_ROLES = createRoleRegistry({
  customer: ['order:read'],
  support: { permissions: ['order:refund', 'profile:read', 'profile:write'], inherits: ['customer'] }
});

// RBAC is also enforced inside the profile service, so jobs and RPC callers are
// checked the same way as HTTP routes.
const BASA_PROFILE_POLICY = createAccessPolicy({
  'profile.create': { permissions: ['profile:write'] },
  'profile.get': { permissions: ['profile:read'] },
  'profile.update': { permissions: ['profile:write'] },
  'profile.delete': { permissions: ['profile:write'] },
  'profile.list': { permissions: ['profile:read'] }
}, { roleRegistry: BASA_ROLES });

/**
 * Basa shows the full stack: RBAC-guarded order operations, profile CRUD, and
 * order notifications that can be sent immediately or scheduled with retries.
 */
export function createBasaIntegration({ jwtSecret, profileStore, adapters, revocationStore = new InMemoryTokenRevocationStore() }) {
  const scheduler = new InMemoryNotificationScheduler();
  const notifications = new NotificationService({ adapters, scheduler, maxScheduleAttempts: 3, retryDelayMs: 60_000, retryBackoffFactor: 2 });
  const guard = createAuthGuard({ secret: jwtSecret, roleRegistry: BASA_ROLES, revocationStore });
  const profiles = new ProfileService({ store: profileStore, policy: BASA_PROFILE_POLICY });

  return {
    scheduler,
    profiles,
    createCustomerProfile: (request, input) => profiles.create(input, { principal: guard(request) }),
    readCustomerProfile: (request, id) => profiles.get(id, { principal: guard(request) }),
    requireOrderRead: (request) => guard(request, { permissions: ['order:read'] }),
    requireRefund: (request) => guard(request, { permissions: ['order:refund'] }),
    sendOrderUpdate: (order) => notifications.send(buildOrderUpdate(order)),
    scheduleOrderUpdate: (order, when) => notifications.schedule(buildOrderUpdate(order), when),
    cancelOrderUpdate: (order) => notifications.cancelScheduled(`order-${order.id}`),
    pendingOrderUpdates: () => notifications.listScheduled(),
    dispatchDueOrderUpdates: (now = new Date()) => notifications.dispatchScheduled({ now })
  };
}

function buildOrderUpdate(order) {
  return {
    id: `order-${order.id}`,
    channels: [CHANNELS.EMAIL, CHANNELS.SMS],
    to: { email: order.email, phone: order.phone },
    subject: 'Order {{id}} update',
    body: 'Your order status is {{status}}.',
    variables: order
  };
}
