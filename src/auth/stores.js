export class InMemoryAccountStore {
  #accounts = new Map();
  #accountIdsByEmail = new Map();

  async upsert(account) {
    const existing = this.#accounts.get(account.id);
    const existingEmail = normalizeEmail(existing?.email);
    if (existingEmail) {
      this.#accountIdsByEmail.delete(existingEmail);
    }

    const storedAccount = { ...account };
    this.#accounts.set(account.id, storedAccount);
    const storedEmail = normalizeEmail(storedAccount.email);
    if (storedEmail) {
      this.#accountIdsByEmail.set(storedEmail, account.id);
    }
    return this.findById(account.id);
  }

  async findById(id) {
    const account = this.#accounts.get(id);
    return account ? { ...account } : undefined;
  }

  async findByEmail(email) {
    const normalized = normalizeEmail(email);
    const accountId = this.#accountIdsByEmail.get(normalized);
    return accountId ? this.findById(accountId) : undefined;
  }
}

function normalizeEmail(email) {
  return typeof email === 'string' ? email.toLowerCase() : undefined;
}
