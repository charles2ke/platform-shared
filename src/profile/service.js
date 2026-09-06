import { randomUUID } from 'node:crypto';
import { toAccessPolicy } from '../auth/policy.js';
import { createError } from '../shared/errors.js';
import { InMemoryProfileStore } from './memory-store.js';
import { assertValidProfile, normalizeProfile } from './validation.js';

/**
 * Profile CRUD over a replaceable store. Supplying `policy` enforces RBAC on
 * every call (`profile.create`, `profile.get`, `profile.update`,
 * `profile.delete`, `profile.list`) so authorization is not limited to HTTP
 * routes. Callers then pass `{ principal }` to each method.
 */
export class ProfileService {
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

  async create(input, options = {}) {
    this.#enforce('profile.create', options);
    const profile = normalizeProfile({ ...input, id: input?.id ?? randomUUID() }, this.defaults);
    assertValidProfile(profile);
    return this.store.create(profile);
  }

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

  async delete(id, options = {}) {
    this.#enforce('profile.delete', options);
    const deleted = await this.store.delete(id);
    if (!deleted) {
      throw createError('PROFILE_NOT_FOUND', 'Profile was not found', { status: 404, details: { id } });
    }
    return true;
  }

  async list(options = {}) {
    this.#enforce('profile.list', options);
    return this.store.list();
  }
}
