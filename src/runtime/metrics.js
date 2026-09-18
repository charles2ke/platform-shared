import { createError } from '../shared/errors.js';

/**
 * Minimal Prometheus-compatible metrics registry. The HPA (or KEDA) scales pods
 * from these series, so they must be cheap and, above all, bounded: label
 * cardinality is capped per metric and excess label sets collapse into an
 * `overflow` series instead of growing the process heap forever.
 */
const NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const DEFAULT_BUCKETS = Object.freeze([0.005, 0.025, 0.1, 0.25, 1, 2.5, 10]);

function assertName(name) {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw createError('INVALID_METRIC_NAME', `Invalid metric name: ${String(name)}`, { status: 500 });
  }
}

function serializeLabels(labels) {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) {
    return '';
  }
  return keys.map((key) => `${key}="${String(labels[key]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`).join(',');
}

export function createMetricsRegistry({ maxSeriesPerMetric = 500, prefix = '' } = {}) {
  const metrics = new Map();

  function metric(type, name, help, options = {}) {
    assertName(prefix + name);
    const key = prefix + name;
    const existing = metrics.get(key);
    if (existing) {
      if (existing.type !== type) {
        throw createError('METRIC_TYPE_CONFLICT', `Metric ${key} is already registered as ${existing.type}`, { status: 500 });
      }
      return existing;
    }

    const created = { type, name: key, help, series: new Map(), buckets: options.buckets ?? DEFAULT_BUCKETS };
    metrics.set(key, created);
    return created;
  }

  function series(entry, labels) {
    const labelKey = serializeLabels(labels);
    let value = entry.series.get(labelKey);
    if (value !== undefined) {
      return value;
    }
    if (entry.series.size >= maxSeriesPerMetric) {
      // Bounded cardinality: never let user-controlled labels grow the heap.
      const overflowKey = serializeLabels({ overflow: 'true' });
      value = entry.series.get(overflowKey);
      if (value === undefined) {
        value = { labels: { overflow: 'true' }, value: 0, counts: undefined, sum: 0, count: 0 };
        entry.series.set(overflowKey, value);
      }
      return value;
    }

    value = { labels: { ...labels }, value: 0, counts: entry.type === 'histogram' ? new Array(entry.buckets.length).fill(0) : undefined, sum: 0, count: 0 };
    entry.series.set(labelKey, value);
    return value;
  }

  return {
    counter(name, help) {
      const entry = metric('counter', name, help);
      return {
        inc(labels = {}, amount = 1) {
          series(entry, labels).value += amount;
        }
      };
    },
    gauge(name, help) {
      const entry = metric('gauge', name, help);
      return {
        set(value, labels = {}) {
          series(entry, labels).value = value;
        },
        inc(labels = {}, amount = 1) {
          series(entry, labels).value += amount;
        },
        dec(labels = {}, amount = 1) {
          series(entry, labels).value -= amount;
        }
      };
    },
    histogram(name, help, { buckets = DEFAULT_BUCKETS } = {}) {
      const entry = metric('histogram', name, help, { buckets });
      return {
        observe(value, labels = {}) {
          const point = series(entry, labels);
          point.counts ??= new Array(entry.buckets.length).fill(0);
          for (let index = 0; index < entry.buckets.length; index += 1) {
            if (value <= entry.buckets[index]) {
              point.counts[index] += 1;
            }
          }
          point.sum += value;
          point.count += 1;
        },
        /** Times an async operation and records its duration in seconds. */
        async time(operation, labels = {}) {
          const startedAt = process.hrtime.bigint();
          try {
            return await operation();
          } finally {
            this.observe(Number(process.hrtime.bigint() - startedAt) / 1e9, labels);
          }
        }
      };
    },
    /** Drops every recorded series; used by tests and after a scale-down drain. */
    reset() {
      metrics.clear();
    },
    /** Prometheus text exposition format (`/metrics`). */
    render() {
      const lines = [];
      for (const entry of metrics.values()) {
        if (entry.help) {
          lines.push(`# HELP ${entry.name} ${entry.help}`);
        }
        lines.push(`# TYPE ${entry.name} ${entry.type}`);
        for (const point of entry.series.values()) {
          const labelKey = serializeLabels(point.labels);
          if (entry.type !== 'histogram') {
            lines.push(`${entry.name}${labelKey ? `{${labelKey}}` : ''} ${point.value}`);
            continue;
          }
          entry.buckets.forEach((bucket, index) => {
            const labels = serializeLabels({ ...point.labels, le: String(bucket) });
            lines.push(`${entry.name}_bucket{${labels}} ${point.counts?.[index] ?? 0}`);
          });
          lines.push(`${entry.name}_bucket{${serializeLabels({ ...point.labels, le: '+Inf' })}} ${point.count}`);
          lines.push(`${entry.name}_sum${labelKey ? `{${labelKey}}` : ''} ${point.sum}`);
          lines.push(`${entry.name}_count${labelKey ? `{${labelKey}}` : ''} ${point.count}`);
        }
      }
      return `${lines.join('\n')}\n`;
    }
  };
}

/**
 * Registers process gauges (heap, RSS, event loop) that back autoscaling and,
 * just as importantly, make a memory leak visible on a dashboard within
 * minutes. Call the returned function before each scrape.
 */
export function registerProcessMetrics(registry, { processRef = process } = {}) {
  const heapUsed = registry.gauge('process_heap_used_bytes', 'Heap actually used by the process');
  const heapTotal = registry.gauge('process_heap_total_bytes', 'Heap allocated by the process');
  const rss = registry.gauge('process_resident_memory_bytes', 'Resident set size of the process');
  const external = registry.gauge('process_external_memory_bytes', 'Memory used by C++ objects bound to JS');
  const uptime = registry.gauge('process_uptime_seconds', 'Process uptime in seconds');

  return function collect() {
    const memory = processRef.memoryUsage();
    heapUsed.set(memory.heapUsed);
    heapTotal.set(memory.heapTotal);
    rss.set(memory.rss);
    external.set(memory.external);
    uptime.set(processRef.uptime());
  };
}
