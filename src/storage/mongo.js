import { createError, normalizeError } from '../shared/errors.js';
import { noopLogger } from '../shared/logger.js';
import { createResiliencePolicy } from '../shared/resilience.js';
import { ProfileStore } from '../profile/memory-store.js';
import { DeadLetterStore } from '../notifications/dead-letter.js';

/**
 * MongoDB-backed persistence. The driver is injected (a `Collection` from the
 * official `mongodb` package, or any object with the same methods), so this
 * package keeps zero runtime dependencies and can be tested with a double.
 *
 * Every query is wrapped in a resilience policy (deadline, bounded retries,
 * circuit breaker) and uses parameterized filters built from validated ids, so
 * user input is never interpolated into a query operator (NoSQL injection).
 */

/** Rejects ids/filters that carry Mongo operators or non-primitive shapes. */
function assertSafeId(id, field = 'id') {
  if (typeof id !== 'string' || id.length === 0 || id.length > 256) {
    throw createError('MONGO_INVALID_ID', `${field} must be a non-empty string of at most 256 characters`, { status: 400 });
  }
  return id;
}

function stripInternalFields(document) {
  if (!document) {
    return undefined;
  }
  const { _id, __v, ...rest } = document;
  return rest;
}

function createPolicy(name, { timeoutMs, retry, breaker, logger }) {
  return createResiliencePolicy({
    name,
    timeoutMs: timeoutMs ?? 5_000,
    retry: { retries: 2, baseDelayMs: 50, maxDelayMs: 1_000, ...retry },
    breaker: { failureThreshold: 5, resetTimeoutMs: 15_000, ...breaker },
    bulkhead: { limit: 64, queueLimit: 2_000 },
    logger
  });
}

/**
 * Profile store on MongoDB. Documents are keyed by the profile `id` (not the
 * generated `_id`), which is also the shard key recommendation for horizontal
 * scaling across a sharded cluster.
 */
export class MongoProfileStore extends ProfileStore {
  #collection;
  #policy;
  #maxListSize;

  constructor({ collection, logger = noopLogger, timeoutMs, retry, breaker, maxListSize = 1_000 } = {}) {
    super();
    if (!collection || typeof collection.findOne !== 'function') {
      throw createError('MONGO_INVALID_COLLECTION', 'A MongoDB collection is required', { status: 500 });
    }
    if (!Number.isInteger(maxListSize) || maxListSize < 1) {
      throw createError('MONGO_INVALID_LIST_SIZE', 'maxListSize must be a positive integer', { status: 500 });
    }

    this.#collection = collection;
    this.#policy = createPolicy('mongo:profiles', { timeoutMs, retry, breaker, logger });
    this.#maxListSize = maxListSize;
  }

  /** Creates the unique index that makes `create()` race-safe across pods. */
  async ensureIndexes() {
    if (typeof this.#collection.createIndex !== 'function') {
      return false;
    }
    await this.#collection.createIndex({ id: 1 }, { unique: true });
    await this.#collection.createIndex({ 'contact.email': 1 }, { sparse: true });
    return true;
  }

  async create(profile) {
    assertSafeId(profile?.id, 'profile.id');
    try {
      await this.#policy.execute(() => this.#collection.insertOne({ ...profile, updatedAt: new Date().toISOString() }));
    } catch (error) {
      if (error?.cause?.code === 11000 || error?.code === 11000) {
        throw createError('PROFILE_ALREADY_EXISTS', 'Profile already exists', { status: 409, details: { id: profile.id } });
      }
      throw normalizeError(error, 'PROFILE_STORE_FAILED');
    }
    return this.get(profile.id);
  }

  async get(id) {
    assertSafeId(id);
    const document = await this.#policy.execute(() => this.#collection.findOne({ id }, { projection: { _id: 0 } }));
    return stripInternalFields(document);
  }

  async update(id, profile) {
    assertSafeId(id);
    const result = await this.#policy.execute(() => this.#collection.updateOne(
      { id },
      { $set: { ...profile, id, updatedAt: new Date().toISOString() } }
    ));
    const matched = result?.matchedCount ?? result?.value ?? 0;
    if (!matched) {
      return undefined;
    }
    return this.get(id);
  }

  async delete(id) {
    assertSafeId(id);
    const result = await this.#policy.execute(() => this.#collection.deleteOne({ id }));
    return (result?.deletedCount ?? 0) > 0;
  }

  /**
   * Lists profiles with a hard page size. Unbounded `find()` results are the
   * classic way a service with a growing collection runs out of memory.
   */
  async list({ limit = this.#maxListSize, cursor } = {}) {
    const pageSize = Math.min(Number.isInteger(limit) && limit > 0 ? limit : this.#maxListSize, this.#maxListSize);
    const filter = cursor === undefined ? {} : { id: { $gt: assertSafeId(cursor, 'cursor') } };
    const documents = await this.#policy.execute(() => this.#collection
      .find(filter, { projection: { _id: 0 } })
      .sort({ id: 1 })
      .limit(pageSize)
      .toArray());
    return documents.map(stripInternalFields);
  }

  /** Readiness probe helper: pings the replica set without throwing. */
  async healthCheck() {
    try {
      await this.#policy.execute(() => this.#collection.findOne({ id: '__health__' }, { projection: { _id: 1 } }));
      return true;
    } catch {
      return false;
    }
  }

  stats() {
    return this.#policy.stats();
  }
}

/**
 * Dead-letter queue on MongoDB with a TTL index, so failed notifications are
 * durable across pod restarts but expire automatically instead of growing
 * without bound.
 */
export class MongoDeadLetterStore extends DeadLetterStore {
  #collection;
  #policy;
  #ttlSeconds;
  #maxDrain;

  constructor({ collection, logger = noopLogger, timeoutMs, retry, breaker, ttlSeconds = 1_209_600, maxDrain = 500 } = {}) {
    super();
    if (!collection || typeof collection.insertOne !== 'function') {
      throw createError('MONGO_INVALID_COLLECTION', 'A MongoDB collection is required', { status: 500 });
    }
    this.#collection = collection;
    this.#policy = createPolicy('mongo:dead-letters', { timeoutMs, retry, breaker, logger });
    this.#ttlSeconds = ttlSeconds;
    this.#maxDrain = maxDrain;
  }

  async ensureIndexes() {
    if (typeof this.#collection.createIndex !== 'function') {
      return false;
    }
    await this.#collection.createIndex({ failedAt: 1 }, { expireAfterSeconds: this.#ttlSeconds });
    await this.#collection.createIndex({ 'notification.id': 1 });
    return true;
  }

  async add(record) {
    if (!record || typeof record !== 'object' || !record.notification) {
      throw createError('NOTIFICATION_INVALID_DEAD_LETTER_RECORD', 'Dead-letter records must include a notification', { status: 500 });
    }
    const stored = { ...record, failedAt: new Date(record.failedAt ?? Date.now()) };
    await this.#policy.execute(() => this.#collection.insertOne(stored));
    return { ...record, failedAt: stored.failedAt.toISOString() };
  }

  async list({ limit = this.#maxDrain } = {}) {
    const documents = await this.#policy.execute(() => this.#collection
      .find({}, { projection: { _id: 0 } })
      .limit(Math.min(limit, this.#maxDrain))
      .toArray());
    return documents.map(stripInternalFields);
  }

  async remove(notificationId) {
    assertSafeId(notificationId, 'notificationId');
    const result = await this.#policy.execute(() => this.#collection.deleteMany({ 'notification.id': notificationId }));
    return result?.deletedCount ?? 0;
  }

  /** Drains a bounded page so replay cannot load the whole backlog at once. */
  async drain({ limit = this.#maxDrain } = {}) {
    const records = await this.list({ limit });
    for (const record of records) {
      if (typeof record.notification?.id === 'string') {
        await this.remove(record.notification.id);
      }
    }
    return records;
  }
}
