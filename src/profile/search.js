import { createError } from '../shared/errors.js';

export const DEFAULT_PROFILE_SEARCH_LIMIT = 50;
export const MAX_PROFILE_SEARCH_LIMIT = 1_000;

/**
 * Validates and normalizes profile search criteria shared by every store.
 * @returns {{query?: string, status?: string, includeDeleted: boolean, limit: number, cursor?: string}}
 */
export function normalizeProfileSearch({ query, status, includeDeleted = false, limit = DEFAULT_PROFILE_SEARCH_LIMIT, cursor } = {}) {
  if (query !== undefined && (typeof query !== 'string' || query.length > 256)) {
    throw createError('PROFILE_INVALID_SEARCH', 'query must be a string of at most 256 characters', { status: 400 });
  }
  if (status !== undefined && typeof status !== 'string') {
    throw createError('PROFILE_INVALID_SEARCH', 'status must be a string', { status: 400 });
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PROFILE_SEARCH_LIMIT) {
    throw createError('PROFILE_INVALID_SEARCH', `limit must be an integer between 1 and ${MAX_PROFILE_SEARCH_LIMIT}`, { status: 400 });
  }
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length === 0)) {
    throw createError('PROFILE_INVALID_SEARCH', 'cursor must be a non-empty string', { status: 400 });
  }
  const trimmed = query?.trim().toLowerCase();
  return {
    query: trimmed ? trimmed : undefined,
    status,
    includeDeleted: includeDeleted === true,
    limit,
    cursor
  };
}

/**
 * In-memory search with keyset pagination ordered by profile `id`: matches
 * `query` case-insensitively against `displayName` and `contact.email`, and
 * hides `deleted` profiles unless `includeDeleted` or an explicit `status` is set.
 * @returns {{items: object[], nextCursor?: string}}
 */
export function searchProfiles(profiles, criteria = {}) {
  const { query, status, includeDeleted, limit, cursor } = normalizeProfileSearch(criteria);
  const matches = profiles
    .filter((profile) => {
      if (cursor !== undefined && !(profile.id > cursor)) {
        return false;
      }
      if (status !== undefined ? profile.status !== status : !includeDeleted && profile.status === 'deleted') {
        return false;
      }
      if (query === undefined) {
        return true;
      }
      return [profile.displayName, profile.contact?.email]
        .some((value) => typeof value === 'string' && value.toLowerCase().includes(query));
    })
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const items = matches.slice(0, limit);
  return { items, nextCursor: matches.length > limit ? items.at(-1).id : undefined };
}
