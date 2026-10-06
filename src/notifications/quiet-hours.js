import { createError } from '../shared/errors.js';

const MINUTES_PER_DAY = 1_440;
const formatters = new Map();

function invalid(message) {
  return createError('NOTIFICATION_INVALID_QUIET_HOURS', message, { status: 400 });
}

function parseClock(value, field) {
  const match = typeof value === 'string' ? /^(\d{2}):(\d{2})$/.exec(value) : null;
  const hours = match ? Number(match[1]) : NaN;
  const minutes = match ? Number(match[2]) : NaN;
  if (!(hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59)) {
    throw invalid(`quietHours.${field} must be a 24-hour "HH:MM" time`);
  }
  return hours * 60 + minutes;
}

function formatterFor(timezone) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    } catch {
      throw invalid(`quietHours.timezone is not a valid IANA timezone: ${String(timezone)}`);
    }
    formatters.set(timezone, formatter);
  }
  return formatter;
}

function localMinutes(date, timezone) {
  const parts = formatterFor(timezone).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  return (hour % 24) * 60 + minute;
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw invalid('Quiet hours check time must be a valid date value');
  }
  return date;
}

/**
 * Validates a quiet-hours window such as `{ start: '22:00', end: '07:00',
 * timezone: 'Europe/London' }`. Windows may wrap past midnight; `start` and
 * `end` must differ. `timezone` defaults to `UTC`.
 */
export function normalizeQuietHours(quietHours) {
  if (!quietHours || typeof quietHours !== 'object' || Array.isArray(quietHours)) {
    throw invalid('quietHours must be an object with start, end, and optional timezone');
  }
  const timezone = quietHours.timezone ?? 'UTC';
  const startMinutes = parseClock(quietHours.start, 'start');
  const endMinutes = parseClock(quietHours.end, 'end');
  if (startMinutes === endMinutes) {
    throw invalid('quietHours.start and quietHours.end must differ');
  }
  formatterFor(timezone);
  return { start: quietHours.start, end: quietHours.end, timezone, startMinutes, endMinutes };
}

/** True when `date` falls inside the quiet-hours window in its timezone. */
export function isWithinQuietHours(date, quietHours) {
  const { startMinutes, endMinutes, timezone } = normalizeQuietHours(quietHours);
  const minutes = localMinutes(toDate(date), timezone);
  return startMinutes < endMinutes
    ? minutes >= startMinutes && minutes < endMinutes
    : minutes >= startMinutes || minutes < endMinutes;
}

/**
 * Earliest delivery time at or after `date` that is outside quiet hours.
 * Returns `date` unchanged when it is already outside the window. The result
 * is corrected for DST offset changes inside the window.
 */
export function nextAllowedDeliveryTime(date, quietHours) {
  const normalized = normalizeQuietHours(quietHours);
  const from = toDate(date);
  if (!isWithinQuietHours(from, normalized)) {
    return from;
  }
  const startOfMinute = from.getTime() - (from.getTime() % 60_000);
  const untilEnd = (normalized.endMinutes - localMinutes(from, normalized.timezone) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  let candidate = startOfMinute + untilEnd * 60_000;
  let drift = (normalized.endMinutes - localMinutes(new Date(candidate), normalized.timezone) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  if (drift > MINUTES_PER_DAY / 2) {
    drift -= MINUTES_PER_DAY;
  }
  candidate += drift * 60_000;
  while (isWithinQuietHours(new Date(candidate), normalized)) {
    candidate += 60_000;
  }
  return new Date(Math.max(candidate, from.getTime()));
}

/**
 * Reads quiet hours from a canonical profile's `preferences.quietHours`,
 * defaulting the timezone to the profile's `timezone`. Returns undefined when
 * the profile has no quiet hours configured.
 */
export function quietHoursFromProfile(profile) {
  const quietHours = profile?.preferences?.quietHours;
  if (!quietHours) {
    return undefined;
  }
  return normalizeQuietHours({ ...quietHours, timezone: quietHours.timezone ?? profile.timezone ?? 'UTC' });
}
