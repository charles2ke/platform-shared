import { randomUUID } from 'node:crypto';
import { createError } from '../shared/errors.js';
import { InMemoryProfileStore } from './memory-store.js';
import { assertValidProfile, normalizeProfile } from './validation.js';

export class ProfileService {
  constructor({ store = new InMemoryProfileStore(), defaults = {} } = {}) {
    this.store = store;
    this.defaults = defaults;
  }

  async create(input) {
    const profile = normalizeProfile({ ...input, id: input?.id ?? randomUUID() }, this.defaults);
    assertValidProfile(profile);
    return this.store.create(profile);
  }

  async get(id) {
    const profile = await this.store.get(id);
    if (!profile) {
      throw createError('PROFILE_NOT_FOUND', 'Profile was not found', { status: 404, details: { id } });
    }
    return profile;
  }

  async update(id, updates) {
    const existing = await this.get(id);
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

  async delete(id) {
    const deleted = await this.store.delete(id);
    if (!deleted) {
      throw createError('PROFILE_NOT_FOUND', 'Profile was not found', { status: 404, details: { id } });
    }
    return true;
  }

  async list() {
    return this.store.list();
  }
}
