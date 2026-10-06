import { randomUUID } from 'node:crypto';
import { toAccessPolicy } from '../auth/policy.js';
import { createError } from '../shared/errors.js';
import { InMemoryProfileStore } from './memory-store.js';
import { searchProfiles } from './search.js';
import { assertValidProfile, normalizeProfile } from './validation.js';

/**
 * @typedef {import('./memory-store.js').Profile} ServiceProfile
 * @typedef {import('./memory-store.js').ProfileStore} ServiceProfileStore
 * @typedef {import('../auth/policy.js').AccessPolicy} ProfileAccessPolicy
 * @typedef {{principal?: import('../auth/rbac.js').Principal, [key: string]: any}} ServiceOptions
 */

/**
 * Profile CRUD over a replaceable store. Supplying `policy` enforces RBAC on
 * every call (`profile.create`, `profile.get`, `profile.update`,
 * `profile.delete`, `profile.list`, plus `profile.restore` and
 * `profile.search`) so authorization is not limited to HTTP routes. Callers
 * then pass `{ principal }` to each method. When `profile.restore` or
 * `profile.search` has no requirement of its own, `profile.delete` and
 * `profile.list` are enforced instead so new methods never bypass RBAC.
 */
export class ProfileService {
  /**
   * @param {{store?: ServiceProfileStore, defaults?: Partial<ServiceProfile>, policy?: ProfileAccessPolicy|Record<string, import('../auth/rbac.js').AccessRequirements>, roleRegistry?: object}} [options]
   */
  constructor({ store = new InMemoryProfileStore(), defaults = {}, policy, roleRegistry } = {}) {
    this.store = store;
    this.defaults = defaults;
    this.policy = toAccessPolicy(policy, { roleRegistry });
  }

  #enforce(action, { principal } = {}) {
    if (this.policy) {
      this.policy.enforce(action, principal);
    }
  }

  #enforceWithFallback(action, fallbackAction, options) {
    if (!this.policy) {
      return;
    }
    const hasOwnRequirement = typeof this.policy.requirementsFor === 'function'
      && this.policy.requirementsFor(action) !== undefined;
    this.#enforce(hasOwnRequirement ? action : fallbackAction, options);
    if (!hasOwnRequirement && typeof this.policy.requirementsFor !== 'function') {
      this.#enforce(action, options);
    }
  }

  /**
   * @param {Partial<ServiceProfile> & {id?: string}} input
   * @param {ServiceOptions} [options]
   * @returns {Promise<ServiceProfile>}
   */
  async create(input, options = {}) {
    this.#enforce('profile.create', options);
    const profile = normalizeProfile({ ...input, id: input?.id ?? randomUUID() }, this.defaults);
    assertValidProfile(profile);
    return this.store.create(profile);
  }

  /**
   * @param {string} id
   * @param {ServiceOptions} [options]
   * @returns {Promise<ServiceProfile>}
   */
  async get(id, options = {}) {
    this.#enforce('profile.get', options);
    return this.#requireProfile(id);
  }

  async #requireProfile(id) {
    const profile = await this.store.get(id);
    if (!profile) {
      throw createError('PROFILE_NOT_FOUND', 'Profile was not found', { status: 404, details: { id } });
    }
    return profile;
  }

  /**
   * @param {string} id
   * @param {Partial<ServiceProfile>} [updates]
   * @param {ServiceOptions} [options]
   * @returns {Promise<ServiceProfile>}
   */
  async update(id, updates = {}, options = {}) {
    this.#enforce('profile.update', options);
    const existing = await this.#requireProfile(id);
    const merged = {
      ...existing,
      ...updates,
      contact: { ...existing.contact, ...updates.contact },
      preferences: { ...existing.preferences, ...updates.preferences },
      metadata: { ...existing.metadata, ...updates.metadata },
      id
    };
    const profile = normalizeProfile(merged, this.defaults);
    assertValidProfile(profile);
    return this.store.update(id, profile);
  }

  /**
   * @param {string} id
   * @param {ServiceOptions} [options]
   * @returns {Promise<boolean>}
   */
  async delete(id, options = {}) {
    this.#enforce('profile.delete', options);
    const deleted = await this.store.delete(id);
    if (!deleted) {
      throw createError('PROFILE_NOT_FOUND', 'Profile was not found', { status: 404, details: { id } });
    }
    return true;
  }

  /**
   * @param {ServiceOptions} [options]
   * @returns {Promise<ServiceProfile[]>}
   */
  async list(options = {}) {
    this.#enforce('profile.list', options);
    return this.store.list();
  }

  /**
   * Soft delete: keeps the record but marks it `deleted` with a `deletedAt`
   * timestamp so it can be restored. Use `delete()` for permanent removal.
   */
  /**
   * @param {string} id
   * @param {ServiceOptions} [options]
   * @returns {Promise<ServiceProfile>}
   */
  async softDelete(id, options = {}) {
    this.#enforce('profile.delete', options);
    const existing = await this.#requireProfile(id);
    if (existing.status === 'deleted') {
      return existing;
    }
    const profile = normalizeProfile({ ...existing, status: 'deleted', deletedAt: new Date().toISOString(), id }, this.defaults);
    assertValidProfile(profile);
    return this.store.update(id, profile);
  }

  /**
   * Restores a soft-deleted profile to `options.status` (default `active`).
   * @param {string} id
   * @param {ServiceOptions & {status?: string}} [options]
   * @returns {Promise<ServiceProfile>}
   */
  async restore(id, options = {}) {
    this.#enforceWithFallback('profile.restore', 'profile.delete', options);
    const existing = await this.#requireProfile(id);
    if (existing.status !== 'deleted') {
      throw createError('PROFILE_NOT_DELETED', 'Only soft-deleted profiles can be restored', { status: 409, details: { id } });
    }
    const { deletedAt, ...rest } = existing;
    const profile = normalizeProfile({ ...rest, status: options.status ?? 'active', id }, this.defaults);
    if (profile.status === 'deleted') {
      throw createError('PROFILE_VALIDATION_FAILED', 'Profile validation failed', { status: 400, details: [{ field: 'status', message: 'Restored status cannot be deleted' }] });
    }
    assertValidProfile(profile);
    return this.store.update(id, profile);
  }

  /**
   * Searches profiles by `query` (display name or email), `status`, and
   * `includeDeleted`, paginated with `limit` and an opaque `cursor`.
   * Delegates to `store.search()` when available, otherwise filters
   * `store.list()` in memory.
   * @param {import('./memory-store.js').ProfileSearchCriteria & ServiceOptions} [criteria]
   * @returns {Promise<import('./memory-store.js').ProfileSearchResult>}
   */
  async search({ principal, ...criteria } = {}) {
    this.#enforceWithFallback('profile.search', 'profile.list', { principal });
    if (typeof this.store.search === 'function') {
      return this.store.search(criteria);
    }
    return searchProfiles(await this.store.list(), criteria);
  }
}
