import { createError, normalizeError } from '../shared/errors.js';
import { noopLogger } from '../shared/logger.js';
import { createResiliencePolicy } from '../shared/resilience.js';
import { ProfileStore } from '../profile/memory-store.js';
import { normalizeProfileSearch } from '../profile/search.js';
import { AccountStore } from '../auth/stores.js';
import { DeadLetterStore } from '../notifications/dead-letter.js';
import { encryptJSON, decryptJSON } from '../shared/crypto.js';

/**
 * @typedef {import('../profile/memory-store.js').Profile} Profile
 * @typedef {{findOne?: Function, insertOne?: Function, updateOne?: Function, deleteOne?: Function, deleteMany?: Function, replaceOne?: Function, find?: Function, createIndex?: Function, findOneAndDelete?: Function}} MongoCollectionLike
 */

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

function isDuplicateKeyError(error) {
  return error?.cause?.code === 11000 || error?.code === 11000;
}

/** Escapes user input so it is matched literally inside a `$regex`. */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

  /**
   * @param {{collection?: MongoCollectionLike|any, logger?: {debug?: Function, info?: Function, warn?: Function, error?: Function}, timeoutMs?: number, retry?: object, breaker?: object, maxListSize?: number}} [options]
   */
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

  /** @param {Profile} profile @returns {Promise<Profile>} */
  async create(profile) {
    assertSafeId(profile?.id, 'profile.id');
    try {
      await this.#policy.execute(() => this.#collection.insertOne({ ...profile, updatedAt: new Date().toISOString() }));
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw createError('PROFILE_ALREADY_EXISTS', 'Profile already exists', { status: 409, details: { id: profile.id } });
      }
      throw normalizeError(error, 'PROFILE_STORE_FAILED');
    }
    return this.get(profile.id);
  }

  /** @param {string|any} id @returns {Promise<Profile|undefined>} */
  async get(id) {
    assertSafeId(id);
    const document = await this.#policy.execute(() => this.#collection.findOne({ id }, { projection: { _id: 0 } }));
    return stripInternalFields(document);
  }

  /** @param {string|any} id @param {Profile} profile @returns {Promise<Profile|undefined>} */
  async update(id, profile) {
    assertSafeId(id);
    const update = { $set: { ...profile, id, updatedAt: new Date().toISOString() } };
    if (profile?.deletedAt === undefined) {
      // Restoring a soft-deleted profile must clear the stored marker.
      update.$unset = { deletedAt: '' };
    }
    const result = await this.#policy.execute(() => this.#collection.updateOne({ id }, update));
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
  /**
   * @param {{limit?: number, cursor?: string|any}} [options]
   * @returns {Promise<Profile[]>}
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

  /**
   * Case-insensitive search over `displayName` and `contact.email` with keyset
   * pagination by `id`. The query text is regex-escaped so it is always
   * matched literally. Returns `{ items, nextCursor }`.
   */
  /**
   * @param {import('../profile/memory-store.js').ProfileSearchCriteria} [criteria]
   * @returns {Promise<import('../profile/memory-store.js').ProfileSearchResult>}
   */
  async search(criteria = {}) {
    const { query, status, includeDeleted, limit, cursor } = normalizeProfileSearch(criteria);
    const pageSize = Math.min(limit, this.#maxListSize);
    const filter = {};
    if (cursor !== undefined) {
      filter.id = { $gt: assertSafeId(cursor, 'cursor') };
    }
    if (status !== undefined) {
      filter.status = status;
    } else if (!includeDeleted) {
      filter.status = { $ne: 'deleted' };
    }
    if (query !== undefined) {
      const pattern = { $regex: escapeRegex(query), $options: 'i' };
      filter.$or = [{ displayName: pattern }, { 'contact.email': pattern }];
    }
    const documents = await this.#policy.execute(() => this.#collection
      .find(filter, { projection: { _id: 0 } })
      .sort({ id: 1 })
      .limit(pageSize + 1)
      .toArray());
    const items = documents.slice(0, pageSize).map(stripInternalFields);
    return { items, nextCursor: documents.length > pageSize ? items.at(-1).id : undefined };
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
 * Account store on MongoDB. Accounts are keyed by `id`; a lower-cased copy of
 * the email is kept in `emailLower` (stripped from results) so `findByEmail()`
 * is case-insensitive and backed by a unique index.
 */
export class MongoAccountStore extends AccountStore {
  #collection;
  #policy;

  /**
   * @param {{collection?: MongoCollectionLike|any, logger?: {debug?: Function, info?: Function, warn?: Function, error?: Function}, timeoutMs?: number, retry?: object, breaker?: object}} [options]
   */
  constructor({ collection, logger = noopLogger, timeoutMs, retry, breaker } = {}) {
    super();
    if (!collection || typeof collection.findOne !== 'function' || typeof collection.replaceOne !== 'function') {
      throw createError('MONGO_INVALID_COLLECTION', 'A MongoDB collection is required', { status: 500 });
    }
    this.#collection = collection;
    // Duplicate-key conflicts are permanent, so they are never retried.
    this.#policy = createPolicy('mongo:accounts', {
      timeoutMs,
      retry: {
        ...retry,
        shouldRetry: (error, attempt) => !isDuplicateKeyError(error) && (retry?.shouldRetry?.(error, attempt) ?? true)
      },
      breaker,
      logger
    });
  }

  async ensureIndexes() {
    if (typeof this.#collection.createIndex !== 'function') {
      return false;
    }
    await this.#collection.createIndex({ id: 1 }, { unique: true });
    await this.#collection.createIndex({ emailLower: 1 }, { unique: true, sparse: true });
    return true;
  }

  /** @param {{id: string, email?: string, [key: string]: any}} account @returns {Promise<{id: string, email?: string, [key: string]: any}|undefined>} */
  async upsert(account) {
    assertSafeId(account?.id, 'account.id');
    const { emailLower: _ignored, ...rest } = account;
    const document = { ...rest, updatedAt: new Date().toISOString() };
    if (typeof account.email === 'string' && account.email.length > 0) {
      document.emailLower = account.email.toLowerCase();
    }
    try {
      await this.#policy.execute(() => this.#collection.replaceOne({ id: account.id }, document, { upsert: true }));
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw createError('AUTH_ACCOUNT_EMAIL_CONFLICT', 'An account with this email already exists', { status: 409, details: { id: account.id } });
      }
      throw normalizeError(error, 'AUTH_ACCOUNT_STORE_FAILED');
    }
    return this.findById(account.id);
  }

  /** @param {string|any} id @returns {Promise<{id: string, email?: string, [key: string]: any}|undefined>} */
  async findById(id) {
    assertSafeId(id);
    const document = await this.#policy.execute(() => this.#collection.findOne({ id }, { projection: { _id: 0 } }));
    return toAccount(document);
  }

  /** @param {string|any} email @returns {Promise<{id: string, email?: string, [key: string]: any}|undefined>} */
  async findByEmail(email) {
    if (typeof email !== 'string' || email.length === 0 || email.length > 320) {
      return undefined;
    }
    const emailLower = email.toLowerCase();
    const document = await this.#policy.execute(() => this.#collection.findOne({ emailLower }, { projection: { _id: 0 } }));
    return toAccount(document);
  }

  stats() {
    return this.#policy.stats();
  }
}

function toAccount(document) {
  const stripped = stripInternalFields(document);
  if (!stripped) {
    return undefined;
  }
  const { emailLower, ...account } = stripped;
  return account;
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
  #encryptionKey;

  /**
   * @param {{collection?: MongoCollectionLike|any, logger?: {debug?: Function, info?: Function, warn?: Function, error?: Function}, timeoutMs?: number, retry?: object, breaker?: object, ttlSeconds?: number, maxDrain?: number, encryptionKey?: string}} [options]
   */
  constructor({ collection, logger = noopLogger, timeoutMs, retry, breaker, ttlSeconds = 1_209_600, maxDrain = 500, encryptionKey } = {}) {
    super();
    if (!collection || typeof collection.insertOne !== 'function') {
      throw createError('MONGO_INVALID_COLLECTION', 'A MongoDB collection is required', { status: 500 });
    }
    if (typeof encryptionKey !== 'string' || encryptionKey.length < 16) {
      throw createError('MONGO_INVALID_ENCRYPTION_KEY', 'encryptionKey must be a string of at least 16 characters; dead-letter records carry PII and must be encrypted at rest', { status: 500 });
    }
    this.#collection = collection;
    this.#policy = createPolicy('mongo:dead-letters', { timeoutMs, retry, breaker, logger });
    this.#ttlSeconds = ttlSeconds;
    this.#maxDrain = maxDrain;
    this.#encryptionKey = encryptionKey;
  }

  async ensureIndexes() {
    if (typeof this.#collection.createIndex !== 'function') {
      return false;
    }
    await this.#collection.createIndex({ failedAt: 1 }, { expireAfterSeconds: this.#ttlSeconds });
    await this.#collection.createIndex({ 'notification.id': 1 });
    return true;
  }

  /**
   * Reconstructs a plain record from a stored document. `notification`, `job`,
   * and any other caller-supplied fields are recovered from the encrypted
   * blob; only the opaque notification id and scheduling metadata are ever
   * stored in plain text.
   */
  #toRecord(document) {
    const decrypted = decryptJSON(document.encrypted, this.#encryptionKey);
    return {
      ...decrypted,
      attempts: document.attempts,
      reason: document.reason,
      failedAt: document.failedAt instanceof Date ? document.failedAt.toISOString() : document.failedAt
    };
  }

  async add(record) {
    if (!record || typeof record !== 'object' || !record.notification) {
      throw createError('NOTIFICATION_INVALID_DEAD_LETTER_RECORD', 'Dead-letter records must include a notification', { status: 500 });
    }
    const { notification, failedAt, attempts, reason, ...rest } = record;
    const encrypted = encryptJSON({ notification, ...rest }, this.#encryptionKey);
    const stored = {
      notification: { id: notification?.id },
      failedAt: new Date(failedAt ?? Date.now()),
      attempts,
      reason,
      encrypted
    };
    await this.#policy.execute(() => this.#collection.insertOne(stored));
    return { ...record, failedAt: stored.failedAt.toISOString() };
  }

  async list({ limit = this.#maxDrain } = {}) {
    const documents = await this.#policy.execute(() => this.#collection
      .find({})
      .sort({ failedAt: 1 })
      .limit(Math.min(limit, this.#maxDrain))
      .toArray());
    return documents.map((document) => this.#toRecord(document));
  }

  async remove(notificationId) {
    assertSafeId(notificationId, 'notificationId');
    const result = await this.#policy.execute(() => this.#collection.deleteMany({ 'notification.id': notificationId }));
    return result?.deletedCount ?? 0;
  }

  /**
   * Drains a bounded page, claiming and deleting one document at a time by its
   * unique `_id` so a record cannot be lost or double-processed by racing with
   * concurrent inserts/removals of the same notification id.
   */
  async drain({ limit = this.#maxDrain } = {}) {
    const bound = Math.min(Number.isInteger(limit) && limit > 0 ? limit : this.#maxDrain, this.#maxDrain);
    const records = [];
    for (let i = 0; i < bound; i += 1) {
      const result = await this.#policy.execute(() => this.#collection.findOneAndDelete({}, { sort: { failedAt: 1 } }));
      const document = result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : result;
      if (!document) {
        break;
      }
      records.push(this.#toRecord(document));
    }
    return records;
  }
}
