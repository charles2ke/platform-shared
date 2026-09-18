import { createError } from './errors.js';
import { noopLogger } from './logger.js';

/**
 * Chaos engineering helpers. Wrapping a dependency call injects latency,
 * errors, or dropped responses on a configurable fraction of calls so retry,
 * circuit-breaker, dead-letter, and Kubernetes probe behaviour can be exercised
 * in staging game days instead of discovered during an incident.
 *
 * Chaos is opt-in and refuses to arm itself in production unless
 * `allowInProduction` is explicitly set.
 */
export function createChaosMonkey({
  enabled = false,
  failureRate = 0,
  latencyRate = 0,
  latencyMs = 250,
  environment = process.env.PLATFORM_ENV ?? process.env.NODE_ENV,
  allowInProduction = false,
  random = Math.random,
  logger = noopLogger,
  sleep = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer?.unref?.(); })
} = {}) {
  for (const [name, rate] of Object.entries({ failureRate, latencyRate })) {
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
      throw createError('INVALID_CHAOS_RATE', `${name} must be a number between 0 and 1`, { status: 500 });
    }
  }

  const productionLike = environment === 'production' || environment === 'prod';
  let armed = enabled && (!productionLike || allowInProduction);
  if (enabled && productionLike && !allowInProduction) {
    logger.warn?.('Chaos injection refused to arm in a production environment');
  }

  const counters = { calls: 0, failures: 0, delays: 0 };

  return {
    get enabled() {
      return armed;
    },
    stats: () => ({ ...counters, enabled: armed }),
    arm(next = true) {
      armed = next && (!productionLike || allowInProduction);
      return armed;
    },
    /** Runs `operation`, possibly delaying it or failing it first. */
    async run(operation, { name = 'dependency' } = {}) {
      if (!armed) {
        return operation();
      }

      counters.calls += 1;
      if (latencyRate > 0 && random() < latencyRate) {
        counters.delays += 1;
        await sleep(latencyMs);
      }
      if (failureRate > 0 && random() < failureRate) {
        counters.failures += 1;
        throw createError('CHAOS_INJECTED_FAILURE', `Chaos experiment failed the ${name} call`, { status: 503, details: { name } });
      }
      return operation();
    }
  };
}

/**
 * Reads a chaos configuration from the environment so experiments are enabled
 * per pod through a ConfigMap instead of a code change.
 */
export function chaosFromEnv(env = process.env, overrides = {}) {
  return createChaosMonkey({
    enabled: env.PLATFORM_CHAOS_ENABLED === 'true',
    failureRate: Number(env.PLATFORM_CHAOS_FAILURE_RATE ?? 0) || 0,
    latencyRate: Number(env.PLATFORM_CHAOS_LATENCY_RATE ?? 0) || 0,
    latencyMs: Number(env.PLATFORM_CHAOS_LATENCY_MS ?? 250) || 250,
    environment: env.PLATFORM_ENV ?? env.NODE_ENV,
    ...overrides
  });
}
