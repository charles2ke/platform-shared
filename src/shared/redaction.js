const REDACTED = '[redacted]';

/**
 * Keys whose values are privacy sensitive (PII) or credentials. Logs, traces,
 * and dead-letter records are scrubbed with these so personal data never leaves
 * the process in plain text.
 */
export const SENSITIVE_KEYS = Object.freeze([
  'accesstoken',
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'dob',
  'email',
  'firstname',
  'fullname',
  'idtoken',
  'lastname',
  'password',
  'phone',
  'phonenumber',
  'refreshtoken',
  'secret',
  'session',
  'ssn',
  'token'
]);

const SENSITIVE_KEY_SET = new Set(SENSITIVE_KEYS);
const BEARER_PATTERN = /\b(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;
const EMAIL_PATTERN = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g;

function isSensitiveKey(key) {
  return SENSITIVE_KEY_SET.has(String(key).toLowerCase().replace(/[^a-z]/g, ''));
}

function redactString(value) {
  return value
    .replace(BEARER_PATTERN, `$1${REDACTED}`)
    .replace(JWT_PATTERN, REDACTED)
    .replace(EMAIL_PATTERN, REDACTED);
}

/**
 * Deep-copies a value with sensitive keys and token/email-looking strings
 * replaced. Depth and breadth are bounded so logging can never become a CPU or
 * memory amplification vector, and cycles are handled.
 */
export function redact(value, { maxDepth = 6, maxItems = 100, seen = new WeakSet(), depth = 0 } = {}) {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= maxDepth) {
    return '[truncated]';
  }
  if (seen.has(value)) {
    return '[circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value.slice(0, maxItems).map((item) => redact(item, { maxDepth, maxItems, seen, depth: depth + 1 }));
    if (value.length > maxItems) {
      items.push(`[+${value.length - maxItems} more]`);
    }
    return items;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    return { name: value.name, code: value.code, message: redactString(value.message), status: value.status };
  }

  const result = {};
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (count >= maxItems) {
      result['...'] = '[truncated]';
      break;
    }
    count += 1;
    result[key] = isSensitiveKey(key) ? REDACTED : redact(item, { maxDepth, maxItems, seen, depth: depth + 1 });
  }
  return result;
}

/**
 * Wraps a logger so every structured argument is redacted before it is written.
 * Use this for any logger passed into services that handle profiles or tokens.
 */
export function createRedactingLogger(logger, options = {}) {
  const wrap = (level) => (message, ...args) => logger?.[level]?.(
    typeof message === 'string' ? redactString(message) : redact(message, options),
    ...args.map((arg) => redact(arg, options))
  );

  return {
    debug: wrap('debug'),
    info: wrap('info'),
    warn: wrap('warn'),
    error: wrap('error')
  };
}
