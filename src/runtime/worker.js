import { normalizeError } from '../shared/errors.js';
import { noopLogger } from '../shared/logger.js';

/**
 * Generic background worker for recurring jobs (cache warm-ups, reconciliation,
 * digest builds, queue drains). The same worker can be scheduled on an interval
 * with `start()` / `stop()` or triggered on demand with `runOnce()` from an HTTP
 * route, CLI command, or external cron trigger.
 *
 * Overlapping runs are skipped instead of queued, so a slow run never stacks up
 * behind the interval. Interval-triggered failures are logged (and forwarded to
 * `onError`) so the loop keeps running.
 *
 * @param {{name?: string, handler: Function, intervalMs?: number, runOnStart?: boolean, timeoutMs?: number, logger?: object, onError?: Function, now?: Function, setIntervalImpl?: Function, clearIntervalImpl?: Function}} options
 */
export function createBackgroundWorker({
  name = 'background-worker',
  handler,
  intervalMs = 60_000,
  runOnStart = false,
  timeoutMs,
  logger = noopLogger,
  onError,
  now = () => Date.now(),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval
} = {}) {
  if (typeof handler !== 'function') {
    throw new TypeError('handler must be a function');
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError('intervalMs must be a positive number');
  }
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new TypeError('timeoutMs must be a positive number');
  }

  let timer;
  let running = false;
  const stats = {
    name,
    runs: 0,
    failures: 0,
    skipped: 0,
    lastStartedAt: undefined,
    lastFinishedAt: undefined,
    lastDurationMs: undefined,
    lastError: undefined
  };

  async function invoke(context) {
    if (timeoutMs === undefined) {
      return handler(context);
    }

    let timeoutTimer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => handler(context)),
        new Promise((_resolve, reject) => {
          timeoutTimer = setTimeout(() => reject(new Error(`${name} run timed out after ${timeoutMs}ms`)), timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timeoutTimer);
    }
  }

  /**
   * Runs the handler once. Returns `{ status: 'skipped' }` when a run is already
   * in flight, `{ status: 'completed', result }` on success, and either
   * `{ status: 'failed', error }` (when `onError` is configured) or a thrown
   * `PlatformError` on failure.
   *
   * @param {object} [context] Passed to the handler, merged with `{ trigger, startedAt }`.
   */
  async function runOnce(context = {}) {
    if (running) {
      stats.skipped += 1;
      logger.debug?.('Skipped background worker run because a run is still in progress', { name });
      return { status: 'skipped', name };
    }

    running = true;
    const startedAt = now();
    stats.lastStartedAt = startedAt;
    try {
      const result = await invoke({ trigger: 'manual', ...context, name, startedAt });
      stats.runs += 1;
      stats.lastError = undefined;
      logger.debug?.('Background worker run completed', { name, durationMs: now() - startedAt });
      return { status: 'completed', name, result };
    } catch (error) {
      const normalized = normalizeError(error, 'BACKGROUND_WORKER_FAILED');
      stats.failures += 1;
      stats.lastError = normalized;
      logger.error?.('Background worker run failed', { name, error: normalized });
      if (typeof onError === 'function') {
        onError(normalized, { name });
        return { status: 'failed', name, error: normalized };
      }
      throw normalized;
    } finally {
      stats.lastFinishedAt = now();
      stats.lastDurationMs = stats.lastFinishedAt - startedAt;
      running = false;
    }
  }

  return {
    name,
    runOnce,
    /** True while a run is in flight. */
    isRunning: () => running,
    /** True once `start()` has scheduled the interval, until `stop()`. */
    isStarted: () => timer !== undefined,
    /** Snapshot of run counters for metrics and health endpoints. */
    getStats: () => ({ ...stats, running, started: timer !== undefined }),
    /** Schedules recurring runs. Safe to call more than once. */
    start() {
      if (timer !== undefined) {
        return timer;
      }

      timer = setIntervalImpl(() => {
        void runOnce({ trigger: 'interval' }).catch(() => undefined);
      }, intervalMs);
      timer?.unref?.();
      if (runOnStart) {
        void runOnce({ trigger: 'start' }).catch(() => undefined);
      }

      return timer;
    },
    /** Stops recurring runs. An in-flight run is left to finish. */
    stop() {
      if (timer !== undefined) {
        clearIntervalImpl(timer);
        timer = undefined;
      }
    }
  };
}
