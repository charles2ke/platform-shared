import { createError } from '../shared/errors.js';

/**
 * Failed-login throttling with temporary lockout, to slow down credential
 * stuffing and password guessing. Keys are caller-defined (for example
 * `${email}` and `${ip}` tracked separately), so one throttle can protect both
 * an account and a source address.
 *
 * The throttle is synchronous and in-process, matching the revocation store
 * contract. Memory is bounded by `maxEntries`: when full, an expired or the
 * oldest unlocked key is evicted before any locked key. When all entries are
 * locked, new keys are not tracked, so flooding cannot lift existing lockouts.
 * Scaled-out deployments that need a shared view should wrap a
 * shared store with the same `check()`/`recordFailure()`/`recordSuccess()`
 * methods.
 */
export function createLoginThrottle({
  maxAttempts = 5,
  windowMs = 15 * 60_000,
  lockoutMs = 15 * 60_000,
  maxEntries = 10_000,
  now = () => Date.now()
} = {}) {
  assertPositiveInteger(maxAttempts, 'maxAttempts');
  assertPositiveInteger(windowMs, 'windowMs');
  assertPositiveInteger(lockoutMs, 'lockoutMs');
  assertPositiveInteger(maxEntries, 'maxEntries');

  const entries = new Map();

  function current(key) {
    const entry = entries.get(key);
    if (!entry) {
      return undefined;
    }
    const time = now();
    if (entry.lockedUntil !== undefined && entry.lockedUntil <= time) {
      entries.delete(key);
      return undefined;
    }
    if (entry.lockedUntil === undefined && entry.windowStart + windowMs <= time) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  }

  function stateOf(key, entry) {
    if (!entry) {
      return { key, allowed: true, failures: 0, remaining: maxAttempts, retryAfterMs: 0 };
    }
    const locked = entry.lockedUntil !== undefined;
    return {
      key,
      allowed: !locked,
      failures: entry.failures,
      remaining: locked ? 0 : Math.max(0, maxAttempts - entry.failures),
      retryAfterMs: locked ? Math.max(0, entry.lockedUntil - now()) : 0,
      lockedUntil: locked ? new Date(entry.lockedUntil).toISOString() : undefined
    };
  }

  function check(key) {
    const normalized = assertKey(key);
    return stateOf(normalized, current(normalized));
  }

  return {
    check,

    /** Throws `AUTH_LOGIN_LOCKED` (429) while the key is locked out. */
    assertAllowed(key) {
      const state = check(key);
      if (!state.allowed) {
        throw createError('AUTH_LOGIN_LOCKED', 'Too many failed login attempts; try again later', {
          status: 429,
          details: { retryAfterSeconds: Math.ceil(state.retryAfterMs / 1000) }
        });
      }
      return state;
    },

    /** Records a failed attempt and locks the key once `maxAttempts` is reached. */
    recordFailure(key) {
      const normalized = assertKey(key);
      const time = now();
      let entry = current(normalized);
      if (entry?.lockedUntil !== undefined) {
        return stateOf(normalized, entry);
      }
      if (!entry) {
        if (entries.size >= maxEntries && !evictOne()) {
          return stateOf(normalized, undefined);
        }
        entry = { failures: 0, windowStart: time, lockedUntil: undefined };
        entries.set(normalized, entry);
      }
      entry.failures += 1;
      if (entry.failures >= maxAttempts) {
        entry.lockedUntil = time + lockoutMs;
      }
      return stateOf(normalized, entry);
    },

    /** Clears tracked failures after a successful login. */
    recordSuccess(key) {
      return entries.delete(assertKey(key));
    },

    reset(key) {
      return entries.delete(assertKey(key));
    },

    prune,

    size: () => entries.size
  };

  /**
   * Frees one slot from an expired entry first, then the oldest unlocked
   * entry. Returns false when every entry is locked.
   */
  function evictOne() {
    for (const [key, entry] of entries) {
      if (!current(key)) {
        return true;
      }
      if (entry.lockedUntil === undefined) {
        entries.delete(key);
        return true;
      }
    }
    return false;
  }

  function prune() {
    let removed = 0;
    for (const key of [...entries.keys()]) {
      if (!current(key)) {
        removed += 1;
      }
    }
    return removed;
  }
}

function assertKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw createError('AUTH_INVALID_THROTTLE_KEY', 'Login throttle key must be a non-empty string', { status: 500 });
  }
  return key;
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw createError('AUTH_INVALID_THROTTLE_CONFIG', `${name} must be a positive integer`, { status: 500 });
  }
}
