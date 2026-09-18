import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackgroundWorker } from '../src/runtime/index.js';

function fakeTimers() {
  const timers = new Map();
  let id = 0;
  return {
    setIntervalImpl(fn) {
      id += 1;
      timers.set(id, fn);
      return id;
    },
    clearIntervalImpl(handle) {
      timers.delete(handle);
    },
    tick() {
      for (const fn of [...timers.values()]) {
        fn();
      }
    },
    get size() {
      return timers.size;
    }
  };
}

test('background worker validates its options', () => {
  assert.throws(() => createBackgroundWorker(), TypeError);
  assert.throws(() => createBackgroundWorker({ handler: () => {}, intervalMs: 0 }), TypeError);
  assert.throws(() => createBackgroundWorker({ handler: () => {}, timeoutMs: -1 }), TypeError);
});

test('background worker runs on demand and reports the result', async () => {
  const contexts = [];
  const worker = createBackgroundWorker({
    name: 'digest',
    handler: (context) => {
      contexts.push(context);
      return 'ok';
    }
  });

  const run = await worker.runOnce({ reason: 'manual-trigger' });
  assert.equal(run.status, 'completed');
  assert.equal(run.result, 'ok');
  assert.equal(contexts[0].trigger, 'manual');
  assert.equal(contexts[0].reason, 'manual-trigger');
  assert.equal(contexts[0].name, 'digest');

  const stats = worker.getStats();
  assert.equal(stats.runs, 1);
  assert.equal(stats.failures, 0);
  assert.equal(stats.running, false);
  assert.ok(stats.lastDurationMs >= 0);
});

test('background worker skips overlapping runs', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const worker = createBackgroundWorker({ handler: () => gate });

  const first = worker.runOnce();
  assert.equal(worker.isRunning(), true);
  const second = await worker.runOnce();
  assert.equal(second.status, 'skipped');

  release();
  assert.equal((await first).status, 'completed');
  assert.equal(worker.getStats().skipped, 1);
});

test('background worker throws normalized errors unless onError is supplied', async () => {
  const strict = createBackgroundWorker({ handler: () => { throw new Error('boom'); } });
  await assert.rejects(() => strict.runOnce(), (error) => error.code === 'BACKGROUND_WORKER_FAILED' && error.message === 'boom');
  assert.equal(strict.getStats().failures, 1);

  const seen = [];
  const lenient = createBackgroundWorker({
    handler: () => { throw new Error('boom'); },
    onError: (error) => seen.push(error)
  });
  const run = await lenient.runOnce();
  assert.equal(run.status, 'failed');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].code, 'BACKGROUND_WORKER_FAILED');
});

test('background worker fails runs that exceed timeoutMs', async () => {
  const worker = createBackgroundWorker({
    handler: () => new Promise(() => {}),
    timeoutMs: 5
  });

  await assert.rejects(() => worker.runOnce(), (error) => error.code === 'BACKGROUND_WORKER_FAILED' && /timed out after 5ms/.test(error.message));
  assert.equal(worker.isRunning(), false);
});

test('background worker can be scheduled on an interval and stopped', async () => {
  const timers = fakeTimers();
  let runs = 0;
  const worker = createBackgroundWorker({
    handler: () => { runs += 1; },
    intervalMs: 1_000,
    runOnStart: true,
    setIntervalImpl: timers.setIntervalImpl,
    clearIntervalImpl: timers.clearIntervalImpl
  });

  assert.equal(worker.isStarted(), false);
  worker.start();
  worker.start();
  assert.equal(timers.size, 1);
  assert.equal(worker.isStarted(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 1);

  timers.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 2);

  worker.stop();
  assert.equal(worker.isStarted(), false);
  timers.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 2);
});

test('interval runs do not reject when the handler fails', async () => {
  const timers = fakeTimers();
  const worker = createBackgroundWorker({
    handler: () => { throw new Error('boom'); },
    setIntervalImpl: timers.setIntervalImpl,
    clearIntervalImpl: timers.clearIntervalImpl
  });

  worker.start();
  timers.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.getStats().failures, 1);
  worker.stop();
});
