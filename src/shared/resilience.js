import { createError, normalizeError } from '../shared/errors.js';
import { noopLogger } from './logger.js';

/**
 * Fault-tolerance primitives shared by every I/O boundary (Kafka, Mongo, Redis,
 * HTTP providers): deadlines, bounded retries with jittered backoff, circuit
 * breaking, and concurrency limiting. They are dependency-free and injectable so
 * they can be unit tested and chaos tested deterministically.
 */

export const CIRCUIT_STATE = Object.freeze({
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half-open'
});

/**
 * Rejects with `OPERATION_TIMEOUT` when `operation` outlives `timeoutMs`.
 *
 * `operation` is invoked with an `AbortSignal` so it can propagate cancellation
 * into the underlying driver call (Mongo/Kafka/HTTP). On timeout the signal is
 * aborted and the wrapper still waits for `operation` to settle before
 * returning, so a caller such as `withRetry` never starts a new attempt while
 * the previous one is still running.
 */
export async function withTimeout(operation, { timeoutMs, name = 'operation', setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  if (typeof operation !== 'function') {
    throw new TypeError('operation must be a function');
  }
  const controller = new AbortController();
  if (timeoutMs === undefined) {
    return operation(controller.signal);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw createError('INVALID_TIMEOUT', 'timeoutMs must be a positive number', { status: 500 });
  }

  let timer;
  let timedOut = false;
  const operationPromise = Promise.resolve().then(() => operation(controller.signal));
  // Swallow late rejections from the aborted attempt so they don't surface as
  // unhandled rejections once we've already settled on the timeout error.
  const settled = operationPromise.catch(() => {});

  try {
    return await Promise.race([
      operationPromise,
      new Promise((_resolve, reject) => {
        timer = setTimeoutImpl(() => {
          timedOut = true;
          const timeoutError = createError('OPERATION_TIMEOUT', `${name} timed out after ${timeoutMs}ms`, { status: 504, details: { name, timeoutMs } });
          controller.abort(timeoutError);
          reject(timeoutError);
        }, timeoutMs);
        timer?.unref?.();
      })
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeoutImpl(timer);
    }
    if (timedOut) {
      await settled;
    }
  }
}

/** Full-jitter exponential backoff delay for the retry that follows `attempt` failures. */
export function backoffDelay(attempt, { baseDelayMs = 100, factor = 2, maxDelayMs = 30_000, jitter = true, random = Math.random } = {}) {
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  const raw = Math.min(maxDelayMs, Math.round(baseDelayMs * factor ** exponent));
  return jitter ? Math.round(random() * raw) : raw;
}

/**
 * Retries `operation` while `shouldRetry` allows it, using jittered backoff.
 * Retries are bounded so a failing dependency degrades instead of stalling.
 */
export async function withRetry(operation, {
  retries = 3,
  baseDelayMs = 100,
  factor = 2,
  maxDelayMs = 30_000,
  jitter = true,
  random = Math.random,
  timeoutMs,
  name = 'operation',
  shouldRetry = () => true,
  onRetry,
  sleep = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer?.unref?.(); })
} = {}) {
  if (!Number.isInteger(retries) || retries < 0) {
    throw createError('INVALID_RETRY_COUNT', 'retries must be a non-negative integer', { status: 500 });
  }

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await withTimeout(operation, { timeoutMs, name });
    } catch (error) {
      const normalized = normalizeError(error, 'OPERATION_FAILED');
      if (attempt > retries || !shouldRetry(normalized, attempt)) {
        throw normalized;
      }
      const delay = backoffDelay(attempt, { baseDelayMs, factor, maxDelayMs, jitter, random });
      onRetry?.({ attempt, delayMs: delay, error: normalized, name });
      await sleep(delay);
    }
  }
}

/**
 * Circuit breaker that stops calling a dependency after repeated failures and
 * probes it again after `resetTimeoutMs`, so one sick dependency cannot exhaust
 * the pod's connections or queue depth.
 */
export function createCircuitBreaker({
  failureThreshold = 5,
  successThreshold = 1,
  resetTimeoutMs = 30_000,
  name = 'dependency',
  now = () => Date.now(),
  onStateChange
} = {}) {
  if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
    throw createError('INVALID_CIRCUIT_BREAKER', 'failureThreshold must be a positive integer', { status: 500 });
  }
  if (!Number.isInteger(successThreshold) || successThreshold < 1) {
    throw createError('INVALID_CIRCUIT_BREAKER', 'successThreshold must be a positive integer', { status: 500 });
  }

  let state = CIRCUIT_STATE.CLOSED;
  let failures = 0;
  let successes = 0;
  let openedAt = 0;
  let halfOpenProbeInFlight = false;

  function transition(next) {
    if (state === next) {
      return;
    }
    const previous = state;
    state = next;
    failures = 0;
    successes = 0;
    if (next === CIRCUIT_STATE.OPEN) {
      openedAt = now();
    }
    onStateChange?.({ name, from: previous, to: next });
  }

  return {
    get state() {
      return state;
    },
    /** Snapshot for health endpoints and metrics. */
    stats: () => ({ name, state, failures, successes }),
    async execute(operation) {
      if (state === CIRCUIT_STATE.OPEN) {
        if (now() - openedAt < resetTimeoutMs) {
          throw createError('CIRCUIT_OPEN', `${name} circuit is open`, { status: 503, details: { name } });
        }
        transition(CIRCUIT_STATE.HALF_OPEN);
        halfOpenProbeInFlight = true;
      } else if (state === CIRCUIT_STATE.HALF_OPEN) {
        if (halfOpenProbeInFlight) {
          throw createError('CIRCUIT_OPEN', `${name} circuit is half-open and already probing`, { status: 503, details: { name } });
        }
        halfOpenProbeInFlight = true;
      }

      try {
        const result = await operation();
        if (state === CIRCUIT_STATE.HALF_OPEN) {
          successes += 1;
          if (successes >= successThreshold) {
            transition(CIRCUIT_STATE.CLOSED);
          }
        } else {
          failures = 0;
        }
        return result;
      } catch (error) {
        if (state === CIRCUIT_STATE.HALF_OPEN) {
          transition(CIRCUIT_STATE.OPEN);
          throw normalizeError(error);
        }
        failures += 1;
        if (failures >= failureThreshold) {
          transition(CIRCUIT_STATE.OPEN);
        }
        throw normalizeError(error);
      } finally {
        if (state === CIRCUIT_STATE.HALF_OPEN) {
          halfOpenProbeInFlight = false;
        }
      }
    }
  };
}

/**
 * Bulkhead: caps in-flight work and the queue in front of it so a slow
 * dependency creates backpressure instead of unbounded memory growth. This is
 * what keeps a pod's memory flat while the HPA adds replicas.
 */
export function createBulkhead({ limit = 10, queueLimit = 1000, name = 'bulkhead' } = {}) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw createError('INVALID_BULKHEAD', 'limit must be a positive integer', { status: 500 });
  }
  if (!Number.isInteger(queueLimit) || queueLimit < 0) {
    throw createError('INVALID_BULKHEAD', 'queueLimit must be a non-negative integer', { status: 500 });
  }

  let active = 0;
  const queue = [];

  function next() {
    if (active >= limit || queue.length === 0) {
      return;
    }
    const job = queue.shift();
    run(job);
  }

  function run({ operation, resolve, reject }) {
    active += 1;
    Promise.resolve()
      .then(operation)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  }

  return {
    stats: () => ({ name, active, queued: queue.length, limit, queueLimit }),
    run(operation) {
      if (typeof operation !== 'function') {
        return Promise.reject(new TypeError('operation must be a function'));
      }
      return new Promise((resolve, reject) => {
        if (active < limit) {
          run({ operation, resolve, reject });
          return;
        }
        if (queue.length >= queueLimit) {
          reject(createError('BULKHEAD_QUEUE_FULL', `${name} queue is full`, { status: 503, details: { name, queueLimit } }));
          return;
        }
        queue.push({ operation, resolve, reject });
      });
    }
  };
}

/**
 * Composes timeout + retry + circuit breaker + bulkhead into one guarded call
 * wrapper for a dependency (Kafka broker, Mongo replica set, Redis, provider).
 */
export function createResiliencePolicy({ name = 'dependency', timeoutMs, retry = {}, breaker, bulkhead, logger = noopLogger } = {}) {
  const circuit = breaker === null ? undefined : createCircuitBreaker({ name, ...breaker });
  const limiter = bulkhead === null || bulkhead === undefined ? undefined : createBulkhead({ name, ...bulkhead });

  async function execute(operation) {
    const guarded = () => withRetry(operation, {
      name,
      timeoutMs,
      onRetry: (info) => logger.warn?.(`${name} call failed, retrying`, { attempt: info.attempt, delayMs: info.delayMs, code: info.error?.code }),
      ...retry
    });
    const withBreaker = circuit ? () => circuit.execute(guarded) : guarded;
    return limiter ? limiter.run(withBreaker) : withBreaker();
  }

  return {
    name,
    execute,
    stats: () => ({ name, circuit: circuit?.stats(), bulkhead: limiter?.stats() }),
    /** Healthy while the circuit is not open; used by readiness probes. */
    healthy: () => circuit === undefined || circuit.state !== CIRCUIT_STATE.OPEN
  };
}
