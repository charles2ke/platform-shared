export class InMemoryAccountStore {
  #accounts = new Map();
  #accountIdsByEmail = new Map();

  async upsert(account) {
    const existing = this.#accounts.get(account.id);
    if (existing?.email) {
      this.#accountIdsByEmail.delete(existing.email.toLowerCase());
    }

    const storedAccount = { ...account };
    this.#accounts.set(account.id, storedAccount);
    if (storedAccount.email) {
      this.#accountIdsByEmail.set(storedAccount.email.toLowerCase(), account.id);
    }
    return this.findById(account.id);
  }

  async findById(id) {
    const account = this.#accounts.get(id);
    return account ? { ...account } : undefined;
  }

  async findByEmail(email) {
    const normalized = email?.toLowerCase();
    const accountId = this.#accountIdsByEmail.get(normalized);
    return accountId ? this.findById(accountId) : undefined;
  }
}
