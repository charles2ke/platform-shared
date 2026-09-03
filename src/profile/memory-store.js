import { createError } from '../shared/errors.js';

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
  async create(profile) {
    return notImplemented('create');
  }

  async get(id) {
    return notImplemented('get');
  }

  async update(id, profile) {
    return notImplemented('update');
  }

  async delete(id) {
    return notImplemented('delete');
  }

  async list() {
    return notImplemented('list');
  }
}

export class InMemoryProfileStore extends ProfileStore {
  #profiles = new Map();

  async create(profile) {
    if (this.#profiles.has(profile.id)) {
      throw createError('PROFILE_ALREADY_EXISTS', 'Profile already exists', { status: 409, details: { id: profile.id } });
    }
    const storedProfile = clone(profile);
    this.#profiles.set(profile.id, storedProfile);
    return clone(storedProfile);
  }

  async get(id) {
    return clone(this.#profiles.get(id));
  }

  async update(id, profile) {
    if (!this.#profiles.has(id)) {
      return undefined;
    }
    this.#profiles.set(id, clone({ ...profile, id }));
    return this.get(id);
  }

  async delete(id) {
    return this.#profiles.delete(id);
  }

  async list() {
    return [...this.#profiles.values()].map(clone);
  }
}
