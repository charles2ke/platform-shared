import { createError, normalizeError } from '../shared/errors.js';
import { noopLogger } from '../shared/logger.js';
import { createResiliencePolicy } from '../shared/resilience.js';
import { ProfileStore } from '../profile/memory-store.js';

/**
 * Redis caching. The client is injected (an ioredis/node-redis instance, or any
 * object exposing `get`, `set`, `del`, `mget`), keeping the package
 * dependency-free.
 *
 * Every entry is written with a TTL, so a cache node can never accumulate keys
 * forever, and the optional in-process layer is an LRU with a hard entry cap
 * for the same reason. Cache failures never fail the request: Redis is treated
 * as an optimization, and a Redis outage degrades latency, not availability.
 */

const DEFAULT_TTL_SECONDS = 300;

/** Bounded LRU used for the in-process tier; eviction keeps memory flat. */
export function createLruCache({ maxEntries = 500, ttlMs = 30_000, now = () => Date.now() } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw createError('CACHE_INVALID_SIZE', 'maxEntries must be a positive integer', { status: 500 });
  }

  const entries = new Map();

  function evictExpired() {
    const current = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= current) {
        entries.delete(key);
      }
    }
  }

  return {
    size: () => entries.size,
    get(key) {
      const entry = entries.get(key);
      if (!entry) {
        return undefined;
      }
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      // Refresh recency.
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      if (entries.has(key)) {
        entries.delete(key);
      } else if (entries.size >= maxEntries) {
        evictExpired();
        if (entries.size >= maxEntries) {
          const oldest = entries.keys().next().value;
          entries.delete(oldest);
        }
      }
      entries.set(key, { value, expiresAt: now() + ttlMs });
    },
    delete: (key) => entries.delete(key),
    clear: () => entries.clear()
  };
}

/**
 * Two-tier cache: a small bounded in-process LRU in front of Redis.
 * `getOrLoad()` collapses concurrent misses for the same key into a single
 * loader call (stampede protection) and always removes the in-flight promise,
 * so nothing is retained after the load settles.
 */
export function createRedisCache({
  client,
  namespace = 'platform',
  ttlSeconds = DEFAULT_TTL_SECONDS,
  logger = noopLogger,
  metrics,
  localCache = createLruCache(),
  timeoutMs = 250,
  chaos,
  subscriber
} = {}) {
  if (!client || typeof client.get !== 'function' || typeof client.set !== 'function') {
    throw createError('CACHE_INVALID_CLIENT', 'A Redis client with get() and set() is required', { status: 500 });
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
    throw createError('CACHE_INVALID_TTL', 'ttlSeconds must be a positive integer', { status: 500 });
  }

  const policy = createResiliencePolicy({
    name: 'redis',
    timeoutMs,
    retry: { retries: 1, baseDelayMs: 20, maxDelayMs: 100 },
    breaker: { failureThreshold: 5, resetTimeoutMs: 10_000 },
    bulkhead: { limit: 64, queueLimit: 1_000 },
    logger
  });
  const hits = metrics?.counter('cache_hits_total', 'Cache hits by tier');
  const misses = metrics?.counter('cache_misses_total', 'Cache misses');
  const errors = metrics?.counter('cache_errors_total', 'Cache backend errors (fail-open)');
  const inFlight = new Map();
  // Local per-key tombstones cover the window where a Redis delete failed but
  // the caller was still told invalidation succeeded (fail-open): while a key
  // is tombstoned this pod treats Redis as untrustworthy for it instead of
  // serving the stale value back out of the cache.
  const tombstones = new Map();
  const invalidationChannel = `${namespace}:cache-invalidate`;
  let stopSubscription;

  if (subscriber && typeof subscriber.subscribe === 'function' && typeof subscriber.on === 'function') {
    subscriber.subscribe(invalidationChannel, (error) => {
      if (error) {
        logger.warn?.('Redis cache invalidation subscribe failed', { code: normalizeError(error).code });
      }
    });
    const onMessage = (channel, key) => {
      if (channel === invalidationChannel) {
        localCache?.delete(key);
      }
    };
    subscriber.on('message', onMessage);
    stopSubscription = () => {
      subscriber.off?.('message', onMessage);
      subscriber.unsubscribe?.(invalidationChannel);
    };
  }

  const keyFor = (key) => `${namespace}:${key}`;

  function isTombstoned(key) {
    const expiresAt = tombstones.get(key);
    if (expiresAt === undefined) {
      return false;
    }
    if (expiresAt <= Date.now()) {
      tombstones.delete(key);
      return false;
    }
    return true;
  }

  async function guarded(operation, fallback) {
    try {
      const run = chaos ? () => chaos.run(operation, { name: 'redis' }) : operation;
      return await policy.execute(run);
    } catch (error) {
      // Fail open: a cache outage must not take the request path down.
      errors?.inc({ namespace });
      logger.warn?.('Redis cache operation failed', { code: normalizeError(error).code });
      return fallback;
    }
  }

  /** Best-effort fan-out so other pods evict their local LRU tier too. */
  async function publishInvalidation(key) {
    if (typeof client.publish !== 'function') {
      return;
    }
    await guarded(() => client.publish(invalidationChannel, key), undefined);
  }

  async function get(key) {
    const local = localCache?.get(key);
    if (local !== undefined) {
      hits?.inc({ namespace, tier: 'local' });
      return local;
    }

    if (isTombstoned(key)) {
      misses?.inc({ namespace });
      return undefined;
    }

    const raw = await guarded(() => client.get(keyFor(key)), null);
    if (raw === null || raw === undefined) {
      misses?.inc({ namespace });
      return undefined;
    }

    try {
      const value = JSON.parse(raw);
      hits?.inc({ namespace, tier: 'redis' });
      localCache?.set(key, value);
      return value;
    } catch {
      // Corrupt entry: drop it rather than serving garbage.
      await del(key);
      misses?.inc({ namespace });
      return undefined;
    }
  }

  async function set(key, value, { ttl = ttlSeconds } = {}) {
    localCache?.set(key, value);
    await guarded(() => client.set(keyFor(key), JSON.stringify(value), 'EX', ttl), undefined);
    return value;
  }

  async function del(key) {
    localCache?.delete(key);
    if (typeof client.del !== 'function') {
      return false;
    }
    const failureToken = Symbol('cache-del-failed');
    const result = await guarded(() => client.del(keyFor(key)), failureToken);
    if (result === failureToken) {
      // Redis invalidation failed but the request path still fails open:
      // record a tombstone so this pod won't serve the stale remote value
      // until it naturally expires (or a later delete succeeds).
      tombstones.set(key, Date.now() + ttlSeconds * 1000);
    } else {
      tombstones.delete(key);
      await publishInvalidation(key);
    }
    return true;
  }

  return {
    namespace,
    get,
    set,
    delete: del,
    stats: () => ({ ...policy.stats(), inFlight: inFlight.size, localEntries: localCache?.size?.() }),
    healthy: () => policy.healthy(),
    /** Stops the pub/sub subscription, for graceful pod shutdown. */
    close: () => stopSubscription?.(),
    /** Read-through with single-flight loading per key. */
    async getOrLoad(key, loader, options = {}) {
      const cached = await get(key);
      if (cached !== undefined) {
        return cached;
      }

      const pending = inFlight.get(key);
      if (pending) {
        return pending;
      }

      const promise = (async () => {
        const value = await loader();
        if (value !== undefined) {
          await set(key, value, options);
        }
        return value;
      })().finally(() => inFlight.delete(key));

      inFlight.set(key, promise);
      return promise;
    }
  };
}

/**
 * Read-through cache decorator for any `ProfileStore` (Mongo in production).
 * Writes invalidate immediately so a scaled-out deployment never serves a stale
 * profile after an update, and negative results are not cached. Cross-pod
 * staleness (other pods' independent in-process LRU tiers) is closed by the
 * underlying cache's Redis pub/sub fan-out when a `subscriber` is configured.
 */
export class CachedProfileStore extends ProfileStore {
  #store;
  #cache;

  constructor({ store, cache } = {}) {
    super();
    if (!store || typeof store.get !== 'function') {
      throw createError('CACHE_INVALID_STORE', 'A profile store is required', { status: 500 });
    }
    if (!cache || typeof cache.getOrLoad !== 'function') {
      throw createError('CACHE_INVALID_CACHE', 'A cache created by createRedisCache() is required', { status: 500 });
    }
    this.#store = store;
    this.#cache = cache;
  }

  async create(profile) {
    const created = await this.#store.create(profile);
    await this.#cache.delete(profile.id);
    return created;
  }

  async get(id) {
    return this.#cache.getOrLoad(id, () => this.#store.get(id));
  }

  async update(id, profile) {
    const updated = await this.#store.update(id, profile);
    await this.#cache.delete(id);
    return updated;
  }

  async delete(id) {
    const deleted = await this.#store.delete(id);
    await this.#cache.delete(id);
    return deleted;
  }

  async list(options) {
    return this.#store.list(options);
  }
}
