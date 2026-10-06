import { createError } from '../shared/errors.js';
import { searchProfiles } from './search.js';

/**
 * @typedef {{id: string, displayName?: string, contact?: Record<string, any>, preferences?: Record<string, any>, metadata?: Record<string, any>, status?: string, deletedAt?: string, [key: string]: any}} Profile
 * @typedef {{query?: any, status?: string, includeDeleted?: boolean, limit?: number, cursor?: string}} ProfileSearchCriteria
 * @typedef {{items: Profile[], nextCursor?: string}} ProfileSearchResult
 */

function clone(value) {
  return value ? structuredClone(value) : value;
}

function notImplemented(method) {
  throw createError('PROFILE_STORE_NOT_IMPLEMENTED', `ProfileStore.${method}() must be implemented`, { status: 500 });
}

/**
 * Contract for persistent profile stores. Downstream apps extend this class (or
 * provide an object with the same methods) to plug their own persistence layer.
 */
export class ProfileStore {
  /** @param {Profile} profile @returns {Promise<Profile>} */
  async create(profile) {
    return notImplemented('create');
  }

  /** @param {string} id @returns {Promise<Profile|undefined>} */
  async get(id) {
    return notImplemented('get');
  }

  /** @param {string} id @param {Profile} profile @returns {Promise<Profile|undefined>} */
  async update(id, profile) {
    return notImplemented('update');
  }

  /** @param {string} id @returns {Promise<boolean>} */
  async delete(id) {
    return notImplemented('delete');
  }

  /** @param {object} [options] @returns {Promise<Profile[]>} */
  async list(options) {
    return notImplemented('list');
  }
}

export class InMemoryProfileStore extends ProfileStore {
  #profiles = new Map();

  /** @param {Profile} profile @returns {Promise<Profile>} */
  async create(profile) {
    if (this.#profiles.has(profile.id)) {
      throw createError('PROFILE_ALREADY_EXISTS', 'Profile already exists', { status: 409, details: { id: profile.id } });
    }
    const storedProfile = clone(profile);
    this.#profiles.set(profile.id, storedProfile);
    return clone(storedProfile);
  }

  /** @param {string} id @returns {Promise<Profile|undefined>} */
  async get(id) {
    return clone(this.#profiles.get(id));
  }

  /** @param {string} id @param {Profile} profile @returns {Promise<Profile|undefined>} */
  async update(id, profile) {
    if (!this.#profiles.has(id)) {
      return undefined;
    }
    this.#profiles.set(id, clone({ ...profile, id }));
    return this.get(id);
  }

  /** @param {string} id @returns {Promise<boolean>} */
  async delete(id) {
    return this.#profiles.delete(id);
  }

  /** @param {object} [options] @returns {Promise<Profile[]>} */
  async list(options) {
    return [...this.#profiles.values()].map(clone);
  }

  /** @param {ProfileSearchCriteria} criteria @returns {Promise<ProfileSearchResult>} */
  async search(criteria) {
    const { items, nextCursor } = searchProfiles([...this.#profiles.values()], criteria);
    return { items: items.map(clone), nextCursor };
  }
}
