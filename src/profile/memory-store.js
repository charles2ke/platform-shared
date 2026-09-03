function clone(value) {
  return value ? structuredClone(value) : value;
}

export class InMemoryProfileStore {
  #profiles = new Map();

  async create(profile) {
    if (this.#profiles.has(profile.id)) {
      throw new Error(`Profile ${profile.id} already exists`);
    }
    this.#profiles.set(profile.id, clone(profile));
    return clone(profile);
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
