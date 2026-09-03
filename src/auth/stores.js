import { createError } from '../shared/errors.js';

function notImplemented(method) {
  throw createError('AUTH_STORE_NOT_IMPLEMENTED', `AccountStore.${method}() must be implemented`, { status: 500 });
}

/**
 * Contract for persistent account stores. Downstream apps extend this class (or
 * provide an object with the same methods) to plug their own persistence layer.
 */
export class AccountStore {
  async upsert(account) {
    return notImplemented('upsert');
  }

  async findById(id) {
    return notImplemented('findById');
  }

  async findByEmail(email) {
    return notImplemented('findByEmail');
  }
}

export class InMemoryAccountStore extends AccountStore {
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
