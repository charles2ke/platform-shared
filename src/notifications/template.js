import { createError } from '../shared/errors.js';

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;
const MAX_TEMPLATE_LENGTH = 64 * 1024;

/**
 * Resolves a dotted path against own, plain-data properties only. Inherited
 * members (`__proto__`, `constructor`, `toString`, ...) never resolve, so a
 * template coming from untrusted input cannot read prototype internals.
 */
function lookup(variables, path) {
  let current = variables;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

/**
 * Renders `{{ dotted.path }}` placeholders from `variables`.
 * Templates are capped at 64 KiB so a single notification cannot pin the event
 * loop with an oversized render.
 */
export function renderTemplate(template, variables = {}) {
  const source = String(template);
  if (source.length > MAX_TEMPLATE_LENGTH) {
    throw createError('NOTIFICATION_TEMPLATE_TOO_LARGE', `Notification templates must be at most ${MAX_TEMPLATE_LENGTH} characters`, { status: 400 });
  }
  if (!source.includes('{{')) {
    return source;
  }

  PLACEHOLDER.lastIndex = 0;
  return source.replace(PLACEHOLDER, (_match, key) => {
    const value = lookup(variables, key);
    if (value === undefined || value === null || typeof value === 'object') {
      return '';
    }
    return String(value);
  });
}
