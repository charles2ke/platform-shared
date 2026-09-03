export class InMemoryAccountStore {
  #accounts = new Map();

  async upsert(account) {
    this.#accounts.set(account.id, { ...account });
    return this.findById(account.id);
  }

  async findById(id) {
    const account = this.#accounts.get(id);
    return account ? { ...account } : undefined;
  }

  async findByEmail(email) {
    const normalized = email?.toLowerCase();
    for (const account of this.#accounts.values()) {
      if (account.email?.toLowerCase() === normalized) {
        return { ...account };
      }
    }
    return undefined;
  }
}
