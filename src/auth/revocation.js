import { createError } from '../shared/errors.js';

function notImplemented(method) {
  throw createError('AUTH_REVOCATION_STORE_NOT_IMPLEMENTED', `TokenRevocationStore.${method}() must be implemented`, { status: 500 });
}

/**
 * Contract for token revocation stores. Implementations must be synchronous so
 * that `verifyToken()` and route guards can stay synchronous. Downstream apps
 * back this with Redis/DB caches loaded into memory, or a synchronous client.
 */
export class TokenRevocationStore {
  revokeToken(payload) {
    return notImplemented('revokeToken');
  }

  revokeSubject(subject, options) {
    return notImplemented('revokeSubject');
  }

  isRevoked(payload) {
    return notImplemented('isRevoked');
  }
}

export class InMemoryTokenRevocationStore extends TokenRevocationStore {
  #revokedTokenIds = new Map();
  #subjectCutoffs = new Map();

  /**
   * Revokes a single token by its `jti` claim.
   * @param {{ jti?: string, exp?: number }} payload A verified token payload.
   */
  revokeToken(payload) {
    const tokenId = payload?.jti;
    if (typeof tokenId !== 'string' || tokenId.length === 0) {
      throw createError('AUTH_TOKEN_NOT_REVOCABLE', 'Token payload must include a jti claim to be revoked', { status: 400 });
    }

    this.#revokedTokenIds.set(tokenId, typeof payload.exp === 'number' ? payload.exp : undefined);
    return tokenId;
  }

  /**
   * Revokes every token issued for a subject at or before `issuedBefore`.
   * @param {string} subject Token subject (`sub` claim).
   * @param {{ issuedBefore?: Date|number }} [options]
   */
  revokeSubject(subject, { issuedBefore = new Date() } = {}) {
    if (typeof subject !== 'string' || subject.length === 0) {
      throw createError('AUTH_MISSING_SUBJECT', 'Token subject is required', { status: 400 });
    }

    const cutoff = toEpochSeconds(issuedBefore);
    const existing = this.#subjectCutoffs.get(subject);
    this.#subjectCutoffs.set(subject, existing === undefined ? cutoff : Math.max(existing, cutoff));
    return cutoff;
  }

  isRevoked(payload) {
    if (!payload || typeof payload !== 'object') {
      return false;
    }

    if (typeof payload.jti === 'string' && this.#revokedTokenIds.has(payload.jti)) {
      return true;
    }

    const cutoff = this.#subjectCutoffs.get(payload.sub);
    return cutoff !== undefined && typeof payload.iat === 'number' && payload.iat <= cutoff;
  }

  /**
   * Drops revocation entries for tokens that already expired.
   * @returns {number} How many entries were removed.
   */
  prune(now = new Date()) {
    const currentTime = toEpochSeconds(now);
    let pruned = 0;
    for (const [tokenId, exp] of this.#revokedTokenIds) {
      if (exp !== undefined && exp <= currentTime) {
        this.#revokedTokenIds.delete(tokenId);
        pruned += 1;
      }
    }
    return pruned;
  }
}

function toEpochSeconds(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw createError('AUTH_INVALID_REVOCATION_TIME', 'Revocation time must be a valid date value', { status: 400 });
  }

  return Math.floor(date.getTime() / 1000);
}
