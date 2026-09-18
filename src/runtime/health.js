import { normalizeError } from '../shared/errors.js';
import { noopLogger } from '../shared/logger.js';

/**
 * Kubernetes probe support. A pod reports three independent signals:
 * - startup: has the process finished booting (slow dependency warm-up)?
 * - liveness: is the process still healthy, or should the kubelet restart it?
 * - readiness: can the pod take traffic right now (dependencies up, not draining)?
 *
 * Checks are registered by name, run with a deadline, and cached briefly so a
 * probe storm cannot amplify load onto Mongo/Redis/Kafka.
 */
export function createHealthRegistry({
  logger = noopLogger,
  checkTimeoutMs = 2_000,
  cacheMs = 1_000,
  now = () => Date.now()
} = {}) {
  const checks = new Map();
  let draining = false;
  let started = false;
  let lastResult;
  let lastResultAt = 0;
  let pendingReady;

  async function runCheck(name, check) {
    const startedAt = now();
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => check.run()),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${name} health check timed out after ${checkTimeoutMs}ms`)), checkTimeoutMs);
          timer?.unref?.();
        })
      ]);
      return { name, critical: check.critical, status: result === false ? 'fail' : 'pass', durationMs: now() - startedAt };
    } catch (error) {
      const normalized = normalizeError(error, 'HEALTH_CHECK_FAILED');
      logger.warn?.('Health check failed', { name, code: normalized.code });
      return { name, critical: check.critical, status: 'fail', error: normalized.code, durationMs: now() - startedAt };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /**
     * @param {string} name Check name reported in the probe body.
     * @param {Function} run Returns/throws to signal health (false === unhealthy).
     * @param {{critical?: boolean}} [options] Critical checks fail readiness.
     * @returns {Function} Unregisters the check, so nothing is retained after use.
     */
    register(name, run, { critical = true } = {}) {
      if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError('health check name must be a non-empty string');
      }
      if (typeof run !== 'function') {
        throw new TypeError('health check run must be a function');
      }
      checks.set(name, { run, critical });
      return () => checks.delete(name);
    },
    /** Marks boot complete; the startup probe passes from here on. */
    markStarted() {
      started = true;
    },
    /** Flips readiness to false so Kubernetes drains traffic before shutdown. */
    beginDraining() {
      draining = true;
      lastResult = undefined;
    },
    isDraining: () => draining,
    isStarted: () => started,
    /** Liveness must not depend on peers, otherwise a broker blip restarts pods. */
    live: () => ({ status: draining ? 'draining' : 'ok', uptimeSeconds: Math.round(process.uptime()) }),
    async ready() {
      if (draining) {
        return { status: 'draining', checks: [] };
      }
      if (lastResult && now() - lastResultAt < cacheMs) {
        return lastResult;
      }
      // Share the in-flight readiness check across concurrent callers so a
      // burst of /readyz requests arriving after expiry runs the dependency
      // checks once, not once per request.
      if (pendingReady) {
        return pendingReady;
      }

      pendingReady = (async () => {
        const results = await Promise.all([...checks].map(([name, check]) => runCheck(name, check)));
        const failedCritical = results.some((result) => result.critical && result.status === 'fail');
        const result = { status: failedCritical || !started ? 'unready' : 'ok', checks: results };
        lastResult = result;
        lastResultAt = now();
        return result;
      })();

      try {
        return await pendingReady;
      } finally {
        pendingReady = undefined;
      }
    }
  };
}

/**
 * Coordinates SIGTERM handling for a pod: stop accepting traffic, let in-flight
 * work finish within `gracePeriodMs`, then close dependencies in reverse
 * registration order. Signal listeners are always removed, so repeated
 * start/stop cycles (tests, rolling restarts) retain nothing.
 */
export function createGracefulShutdown({
  health,
  logger = noopLogger,
  gracePeriodMs = 15_000,
  signals = ['SIGTERM', 'SIGINT'],
  processRef = process,
  exit = (code) => processRef.exit(code)
} = {}) {
  const hooks = [];
  let shuttingDown;
  let listeners = [];

  function removeListeners() {
    for (const { signal, handler } of listeners) {
      processRef.removeListener(signal, handler);
    }
    listeners = [];
  }

  async function shutdown(reason = 'manual') {
    if (shuttingDown) {
      return shuttingDown;
    }

    logger.info?.('Shutdown started', { reason });
    health?.beginDraining?.();
    shuttingDown = (async () => {
      const deadline = new Promise((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), gracePeriodMs);
        timer?.unref?.();
      });
      const drain = (async () => {
        for (const hook of [...hooks].reverse()) {
          try {
            await hook.close();
          } catch (error) {
            logger.error?.('Shutdown hook failed', { name: hook.name, code: normalizeError(error).code });
          }
        }
        return 'closed';
      })();

      const outcome = await Promise.race([drain, deadline]);
      hooks.length = 0;
      removeListeners();
      logger.info?.('Shutdown finished', { outcome });
      return outcome;
    })();

    return shuttingDown;
  }

  return {
    /** Registers a dependency to close on shutdown (server, consumer, client). */
    onShutdown(name, close) {
      if (typeof close !== 'function') {
        throw new TypeError('close must be a function');
      }
      hooks.push({ name, close });
      return () => {
        const index = hooks.findIndex((hook) => hook.close === close);
        if (index !== -1) {
          hooks.splice(index, 1);
        }
      };
    },
    isShuttingDown: () => shuttingDown !== undefined,
    shutdown,
    /** Attaches signal handlers; returns a function that detaches them. */
    listen() {
      if (listeners.length > 0) {
        return removeListeners;
      }
      for (const signal of signals) {
        const handler = () => {
          void shutdown(signal).then((outcome) => exit(outcome === 'timeout' ? 1 : 0));
        };
        processRef.on(signal, handler);
        listeners.push({ signal, handler });
      }
      return removeListeners;
    }
  };
}
