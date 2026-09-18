import { randomUUID } from 'node:crypto';
import { createError, normalizeError } from '../shared/errors.js';
import { noopLogger } from '../shared/logger.js';
import { createResiliencePolicy } from '../shared/resilience.js';

/**
 * Kafka streaming integration. The package stays dependency-free: callers inject
 * a kafkajs-compatible client (`producer.send()`, `consumer.run()`), so the same
 * code runs against Kafka, Redpanda, MSK, or an in-memory test double.
 *
 * Design goals
 * - at-least-once delivery with idempotency keys so consumers can dedupe,
 * - bounded in-flight work (one batch at a time, `eachMessage` backpressure),
 * - retries with jittered backoff, then a dead-letter topic instead of a poison
 *   message looping forever,
 * - consumer lag exported as a metric so KEDA/HPA can scale pods on backlog.
 */

const MAX_MESSAGE_BYTES = 1024 * 1024;

/** Envelope every platform event is published in. */
export function createEventEnvelope(type, payload, { key, correlationId, source = 'platform-shared', now = () => new Date() } = {}) {
  if (typeof type !== 'string' || type.length === 0) {
    throw createError('STREAM_INVALID_EVENT_TYPE', 'Event type must be a non-empty string', { status: 400 });
  }

  return {
    id: randomUUID(),
    type,
    source,
    key,
    correlationId,
    occurredAt: now().toISOString(),
    payload
  };
}

/**
 * Publishes domain events to Kafka with retries, a circuit breaker, and a
 * bulkhead so a broker outage degrades the caller instead of exhausting memory.
 */
export function createKafkaEventPublisher({
  producer,
  topic,
  logger = noopLogger,
  metrics,
  timeoutMs = 5_000,
  retry = { retries: 3, baseDelayMs: 100, maxDelayMs: 2_000 },
  breaker = { failureThreshold: 5, resetTimeoutMs: 15_000 },
  bulkhead = { limit: 32, queueLimit: 1000 },
  chaos,
  maxMessageBytes = MAX_MESSAGE_BYTES
} = {}) {
  if (!producer || typeof producer.send !== 'function') {
    throw createError('STREAM_INVALID_PRODUCER', 'A Kafka producer with send() is required', { status: 500 });
  }
  if (typeof topic !== 'string' || topic.length === 0) {
    throw createError('STREAM_INVALID_TOPIC', 'A Kafka topic is required', { status: 500 });
  }

  const policy = createResiliencePolicy({ name: `kafka:${topic}`, timeoutMs, retry, breaker, bulkhead, logger });
  const published = metrics?.counter('kafka_events_published_total', 'Events published to Kafka');
  const failed = metrics?.counter('kafka_events_publish_failed_total', 'Events that could not be published to Kafka');

  async function publish(event, { key = event.key ?? event.id, headers = {} } = {}) {
    const value = JSON.stringify(event);
    if (Buffer.byteLength(value) > maxMessageBytes) {
      throw createError('STREAM_MESSAGE_TOO_LARGE', `Event exceeds ${maxMessageBytes} bytes`, { status: 413, details: { type: event?.type } });
    }

    const send = () => producer.send({
      topic,
      messages: [{
        key: key === undefined ? undefined : String(key),
        value,
        headers: { 'event-type': String(event.type ?? 'unknown'), 'event-id': String(event.id ?? ''), ...headers }
      }]
    });

    try {
      const result = await policy.execute(chaos ? () => chaos.run(send, { name: `kafka:${topic}` }) : send);
      published?.inc({ topic, type: event.type ?? 'unknown' });
      return result;
    } catch (error) {
      failed?.inc({ topic, type: event.type ?? 'unknown' });
      throw normalizeError(error, 'STREAM_PUBLISH_FAILED');
    }
  }

  return {
    topic,
    publish,
    /** Publishes a batch, preserving per-message keys for partition ordering. */
    async publishAll(events, options = {}) {
      const results = [];
      for (const event of events) {
        results.push(await publish(event, options));
      }
      return results;
    },
    stats: () => policy.stats(),
    healthy: () => policy.healthy()
  };
}

/**
 * Runs a Kafka consumer with at-least-once semantics, bounded retries, a
 * dead-letter topic, offset commits after successful handling, and graceful
 * stop on SIGTERM. Processing stays sequential per partition so memory use is
 * flat regardless of backlog size; scale out with more pods/partitions.
 */
export function createKafkaConsumerWorker({
  consumer,
  topics,
  handler,
  groupId,
  logger = noopLogger,
  metrics,
  deadLetterPublisher,
  maxAttempts = 3,
  retry = { retries: 2, baseDelayMs: 200, maxDelayMs: 5_000 },
  timeoutMs = 30_000,
  chaos,
  fromBeginning = false
} = {}) {
  if (!consumer || typeof consumer.run !== 'function' || typeof consumer.subscribe !== 'function') {
    throw createError('STREAM_INVALID_CONSUMER', 'A Kafka consumer with subscribe() and run() is required', { status: 500 });
  }
  if (typeof handler !== 'function') {
    throw createError('STREAM_INVALID_HANDLER', 'A message handler function is required', { status: 500 });
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw createError('STREAM_INVALID_MAX_ATTEMPTS', 'maxAttempts must be a positive integer', { status: 500 });
  }

  const topicList = Array.isArray(topics) ? topics : [topics];
  if (topicList.length === 0 || topicList.some((topic) => typeof topic !== 'string' || topic.length === 0)) {
    throw createError('STREAM_INVALID_TOPIC', 'At least one Kafka topic is required', { status: 500 });
  }

  const policy = createResiliencePolicy({ name: `kafka-consumer:${groupId ?? topicList[0]}`, timeoutMs, retry, breaker: null, bulkhead: null, logger });
  const processed = metrics?.counter('kafka_messages_processed_total', 'Messages processed from Kafka');
  const deadLettered = metrics?.counter('kafka_messages_dead_lettered_total', 'Messages sent to the dead-letter topic');
  const lag = metrics?.gauge('kafka_consumer_lag_messages', 'Consumer lag used for autoscaling decisions');
  const duration = metrics?.histogram('kafka_message_duration_seconds', 'Time spent handling one Kafka message');

  let running = false;
  let inFlight = 0;

  function decode(message) {
    if (message?.value === undefined || message.value === null) {
      return undefined;
    }
    const raw = Buffer.isBuffer(message.value) ? message.value.toString('utf8') : String(message.value);
    try {
      return JSON.parse(raw);
    } catch (cause) {
      throw createError('STREAM_INVALID_MESSAGE', 'Kafka message value is not valid JSON', { status: 400, cause });
    }
  }

  async function handleMessage({ topic, partition, message, heartbeat }) {
    inFlight += 1;
    const attempts = Number(message?.headers?.['retry-attempts']?.toString?.() ?? 0) || 0;
    const run = async () => {
      const event = decode(message);
      await handler(event, { topic, partition, offset: message?.offset, headers: message?.headers, heartbeat });
    };

    try {
      const guarded = chaos ? () => chaos.run(run, { name: `kafka:${topic}` }) : run;
      if (duration) {
        await duration.time(() => policy.execute(guarded), { topic });
      } else {
        await policy.execute(guarded);
      }
      processed?.inc({ topic, result: 'ok' });
    } catch (error) {
      const normalized = normalizeError(error, 'STREAM_HANDLER_FAILED');
      processed?.inc({ topic, result: 'error' });
      logger.warn?.('Kafka message handling failed', { topic, partition, attempts, code: normalized.code });

      if (attempts + 1 >= maxAttempts && deadLetterPublisher) {
        deadLettered?.inc({ topic });
        await deadLetterPublisher.publish(
          createEventEnvelope('stream.dead-letter', {
            topic,
            partition,
            offset: message?.offset,
            attempts: attempts + 1,
            reason: normalized.code
          }),
          { key: message?.key?.toString?.() }
        );
        return;
      }
      // Rethrow so the broker redelivers and offsets are not advanced.
      throw normalized;
    } finally {
      inFlight -= 1;
    }
  }

  return {
    topics: topicList,
    isRunning: () => running,
    inFlight: () => inFlight,
    /** Reports lag per partition so KEDA/HPA can scale on backlog. */
    recordLag(partitionLag = {}) {
      if (!lag) {
        return;
      }
      for (const [partition, value] of Object.entries(partitionLag)) {
        lag.set(Number(value) || 0, { partition: String(partition), group: groupId ?? 'default' });
      }
    },
    async start() {
      if (running) {
        return;
      }
      for (const topic of topicList) {
        await consumer.subscribe({ topic, fromBeginning });
      }
      await consumer.run({
        // One message at a time: bounded memory, predictable per-pod throughput.
        eachMessage: (payload) => handleMessage(payload)
      });
      running = true;
      logger.info?.('Kafka consumer started', { topics: topicList, groupId });
    },
    /** Stops consuming and waits for in-flight handling, for pod termination. */
    async stop() {
      if (!running) {
        return;
      }
      running = false;
      await consumer.stop?.();
      await consumer.disconnect?.();
      logger.info?.('Kafka consumer stopped', { topics: topicList, groupId });
    }
  };
}

/**
 * In-memory Kafka double for tests, local development, and chaos experiments.
 * Retains at most `maxMessages` per topic so long test runs cannot grow the heap.
 */
export function createInMemoryKafka({ maxMessages = 1000 } = {}) {
  const topics = new Map();

  function topicLog(topic) {
    let log = topics.get(topic);
    if (!log) {
      log = [];
      topics.set(topic, log);
    }
    return log;
  }

  return {
    messages: (topic) => [...topicLog(topic)],
    clear: () => topics.clear(),
    producer: {
      async send({ topic, messages }) {
        const log = topicLog(topic);
        for (const message of messages) {
          log.push(message);
          if (log.length > maxMessages) {
            log.shift();
          }
        }
        return [{ topicName: topic, partition: 0 }];
      }
    },
    consumer(topic) {
      let handler;
      return {
        async subscribe() {},
        async run({ eachMessage }) {
          handler = eachMessage;
        },
        async stop() {
          handler = undefined;
        },
        async disconnect() {
          handler = undefined;
        },
        /** Feeds one message into the registered handler. */
        async deliver(message, partition = 0) {
          if (!handler) {
            throw new Error('consumer is not running');
          }
          return handler({ topic, partition, message });
        }
      };
    }
  };
}
