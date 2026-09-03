import { createError } from '../shared/errors.js';

export const PROFILE_STATUSES = Object.freeze(['active', 'inactive', 'suspended', 'deleted']);

function normalizeString(value) {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function isValidEmail(value) {
  if (typeof value !== 'string' || value.length > 320) {
    return false;
  }

  if (value !== value.trim() || [' ', '\t', '\n', '\r'].some((character) => value.includes(character))) {
    return false;
  }

  const atIndex = value.indexOf('@');
  if (atIndex <= 0 || atIndex !== value.lastIndexOf('@')) {
    return false;
  }

  const domain = value.slice(atIndex + 1);
  const lastDotIndex = domain.lastIndexOf('.');
  return lastDotIndex > 0 && lastDotIndex < domain.length - 1 && domain.split('.').every(Boolean);
}

export function normalizeProfile(input = {}, defaults = {}) {
  const contact = input.contact ?? {};
  const preferences = input.preferences ?? {};
  return {
    id: normalizeString(input.id),
    displayName: normalizeString(input.displayName),
    contact: {
      email: typeof contact.email === 'string' ? normalizeString(contact.email)?.toLowerCase() : contact.email,
      phone: normalizeString(contact.phone)
    },
    preferences: { ...preferences },
    timezone: normalizeString(input.timezone) ?? defaults.timezone ?? 'UTC',
    locale: normalizeString(input.locale) ?? defaults.locale ?? 'en-US',
    avatarUrl: normalizeString(input.avatarUrl),
    status: normalizeString(input.status) ?? 'active',
    metadata: { ...(input.metadata ?? {}) }
  };
}

export function validateProfile(profile) {
  const errors = [];
  if (typeof profile.id !== 'string' || profile.id.length === 0) {
    errors.push({ field: 'id', message: 'Profile id is required' });
  }
  if (!profile.displayName || profile.displayName.length < 2) {
    errors.push({ field: 'displayName', message: 'Display name must be at least 2 characters' });
  }
  if (profile.contact?.email && !isValidEmail(profile.contact.email)) {
    errors.push({ field: 'contact.email', message: 'Email address is invalid' });
  }
  if (profile.avatarUrl) {
    try {
      const url = new URL(profile.avatarUrl);
      if (!['http:', 'https:'].includes(url.protocol)) {
        errors.push({ field: 'avatarUrl', message: 'Avatar URL must use http or https' });
      }
    } catch {
      errors.push({ field: 'avatarUrl', message: 'Avatar URL is invalid' });
    }
  }
  if (!PROFILE_STATUSES.includes(profile.status)) {
    errors.push({ field: 'status', message: `Status must be one of: ${PROFILE_STATUSES.join(', ')}` });
  }
  if (!profile.timezone) {
    errors.push({ field: 'timezone', message: 'Timezone is required' });
  }
  if (!profile.locale) {
    errors.push({ field: 'locale', message: 'Locale is required' });
  }
  return errors;
}

export function assertValidProfile(profile) {
  const errors = validateProfile(profile);
  if (errors.length > 0) {
    throw createError('PROFILE_VALIDATION_FAILED', 'Profile validation failed', { status: 400, details: errors });
  }
}
