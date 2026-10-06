export const CHANNELS = Object.freeze({
  EMAIL: 'email',
  SMS: 'sms',
  PUSH: 'push'
});

export const DELIVERY_STATUS = Object.freeze({
  PENDING: 'pending',
  SENT: 'sent',
  FAILED: 'failed',
  PARTIAL: 'partial'
});

/**
 * `all` delivers on every channel; `fallback` tries channels in order and
 * stops at the first one that does not fail.
 */
export const DELIVERY_STRATEGY = Object.freeze({
  ALL: 'all',
  FALLBACK: 'fallback'
});
