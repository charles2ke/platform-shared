import { randomUUID } from 'node:crypto';
import { toAccessPolicy } from '../auth/policy.js';
import { createError, normalizeError } from '../shared/errors.js';
import { noopLogger } from '../shared/logger.js';
import { createResiliencePolicy } from '../shared/resilience.js';
import { TRANSCODE_STATUS, normalizeTranscodeJob } from './types.js';

/**
 * Transcoding service for video, audio, and image assets.
 *
 * Submitting a job is cheap and non-blocking: the validated specification is
 * published to Kafka, and a pool of worker pods consumes the topic. Because the
 * backlog lives in Kafka (not in process memory), workers can be scaled to zero
 * and back up by KEDA/HPA on consumer lag, and a pod restart never loses a job.
 *
 * RBAC is enforced per action (`media.transcode.submit`, `media.transcode.run`)
 * exactly like the profile and notification services.
 */
export class MediaTranscodingService {
  #inFlight = 0;

  constructor({
    transcoder,
    publisher,
    logger = noopLogger,
    metrics,
    policy,
    roleRegistry,
    maxAttempts = 3,
    maxConcurrency = 2,
    timeoutMs = 900_000,
    deadLetterStore,
    chaos,
    now = () => new Date()
  } = {}) {
    if (!transcoder || typeof transcoder.transcode !== 'function') {
      throw createError('MEDIA_INVALID_TRANSCODER', 'A transcoder with transcode() is required', { status: 500 });
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw createError('MEDIA_INVALID_MAX_ATTEMPTS', 'maxAttempts must be a positive integer', { status: 500 });
    }
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw createError('MEDIA_INVALID_CONCURRENCY', 'maxConcurrency must be a positive integer', { status: 500 });
    }

    this.transcoder = transcoder;
    this.publisher = publisher;
    this.logger = logger;
    this.metrics = metrics;
    this.policy = toAccessPolicy(policy, { roleRegistry });
    this.maxAttempts = maxAttempts;
    this.deadLetterStore = deadLetterStore;
    this.chaos = chaos;
    this.now = now;
    // One transcode is CPU/IO heavy: the bulkhead caps concurrent encodes per
    // pod so the container stays inside its CPU/memory limits.
    this.resilience = createResiliencePolicy({
      name: 'media-transcode',
      timeoutMs,
      retry: { retries: 0 },
      breaker: null,
      bulkhead: { limit: maxConcurrency, queueLimit: maxConcurrency * 4 },
      logger
    });
    this.submitted = metrics?.counter('media_jobs_submitted_total', 'Transcoding jobs submitted');
    this.completed = metrics?.counter('media_jobs_completed_total', 'Transcoding jobs completed');
    this.duration = metrics?.histogram('media_job_duration_seconds', 'Transcoding job duration', { buckets: [1, 5, 15, 60, 300, 900] });
    this.active = metrics?.gauge('media_jobs_active', 'Transcoding jobs currently running');
  }

  #enforce(action, { principal } = {}) {
    if (this.policy) {
      this.policy.enforce(action, principal);
    }
  }

  /** Jobs running in this pod; exported so autoscaling can see saturation. */
  inFlight() {
    return this.#inFlight;
  }

  /**
   * Validates and queues a transcoding job on the Kafka topic.
   * @returns {Promise<{id: string, status: string, job: object}>}
   */
  async submit(input, options = {}) {
    this.#enforce('media.transcode.submit', options);
    if (!this.publisher) {
      throw createError('MEDIA_NO_PUBLISHER', 'submit() requires a publisher; use run() for synchronous execution', { status: 500 });
    }
    const job = normalizeTranscodeJob({ ...input, id: input?.id ?? randomUUID() });
    job.id ??= randomUUID();

    await this.publisher.publish({
      id: job.id,
      type: 'media.transcode.requested',
      occurredAt: this.now().toISOString(),
      key: job.id,
      payload: job
    });

    this.submitted?.inc({ kind: job.kind, format: job.format });
    return { id: job.id, status: TRANSCODE_STATUS.QUEUED, job };
  }

  /**
   * Runs one job. Used directly for synchronous callers and by the Kafka
   * consumer worker for queued jobs. Failures past `maxAttempts` are
   * dead-lettered instead of being retried forever.
   */
  async run(input, options = {}) {
    this.#enforce('media.transcode.run', options);
    const job = normalizeTranscodeJob({ ...input, id: input?.id ?? randomUUID() });
    const attempts = Number.isInteger(options.attempts) && options.attempts >= 0 ? options.attempts : 0;
    const startedAt = Date.now();

    this.#inFlight += 1;
    this.active?.set(this.#inFlight);
    try {
      const execute = () => this.transcoder.transcode(job, { signal: options.signal });
      const guarded = this.chaos ? () => this.chaos.run(execute, { name: 'media-transcode' }) : execute;
      const result = await this.resilience.execute(guarded);
      this.completed?.inc({ kind: job.kind, result: 'ok' });
      this.duration?.observe((Date.now() - startedAt) / 1000, { kind: job.kind });
      return { id: job.id, status: TRANSCODE_STATUS.COMPLETED, attempts: attempts + 1, output: result, job };
    } catch (error) {
      const normalized = normalizeError(error, 'MEDIA_TRANSCODE_FAILED');
      this.completed?.inc({ kind: job.kind, result: 'error' });
      this.logger.warn?.('Transcoding job failed', { jobId: job.id, kind: job.kind, attempts: attempts + 1, code: normalized.code });

      if (attempts + 1 >= this.maxAttempts) {
        const deadLettered = await this.#deadLetter(job, attempts + 1, normalized);
        if (!deadLettered) {
          throw normalized;
        }
        return { id: job.id, status: TRANSCODE_STATUS.FAILED, attempts: attempts + 1, deadLettered: true, error: normalized.toJSON().error, job };
      }
      throw normalized;
    } finally {
      this.#inFlight -= 1;
      this.active?.set(this.#inFlight);
    }
  }

  async #deadLetter(job, attempts, error) {
    if (!this.deadLetterStore) {
      return false;
    }
    try {
      await this.deadLetterStore.add({
        notification: { id: job.id, kind: job.kind },
        job,
        attempts,
        reason: error.code,
        failedAt: this.now().toISOString()
      });
      return true;
    } catch (storeError) {
      this.logger.warn?.('Media dead-letter store failed', { jobId: job.id, code: normalizeError(storeError).code });
      return false;
    }
  }

  /** Handler for `createKafkaConsumerWorker()`. */
  handler(options = {}) {
    return async (event, context = {}) => {
      const attempts = Number(context.headers?.['retry-attempts']?.toString?.() ?? 0) || 0;
      return this.run(event?.payload ?? event, { ...options, attempts });
    };
  }
}
