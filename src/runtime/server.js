import { createServer } from 'node:http';
import { noopLogger } from '../shared/logger.js';

/**
 * Small operations server for a Kubernetes pod: liveness, readiness, and
 * startup probes plus the Prometheus `/metrics` endpoint the HPA scrapes.
 *
 * It listens on its own port (default 9090) so probes and metrics are never
 * exposed on the public application port, request bodies are ignored, and every
 * socket is tracked so `close()` cannot leave dangling handles behind.
 */
export function createOpsServer({
  health,
  metrics,
  collect,
  logger = noopLogger,
  port = Number(process.env.PLATFORM_OPS_PORT ?? 9090),
  host = process.env.PLATFORM_OPS_HOST ?? '0.0.0.0',
  headersTimeoutMs = 5_000,
  requestTimeoutMs = 10_000
} = {}) {
  if (!health || typeof health.ready !== 'function') {
    throw new TypeError('health must be a registry created by createHealthRegistry()');
  }

  const sockets = new Set();

  function json(response, status, body) {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    });
    response.end(payload);
  }

  const server = createServer((request, response) => {
    // Probes and scrapes are GET-only; anything else is rejected outright.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', status: 405 } });
      return;
    }
    request.resume();

    const path = (request.url ?? '/').split('?')[0];
    if (path === '/livez' || path === '/healthz') {
      json(response, 200, health.live());
      return;
    }
    if (path === '/startupz') {
      json(response, health.isStarted() ? 200 : 503, { status: health.isStarted() ? 'ok' : 'starting' });
      return;
    }
    if (path === '/readyz') {
      health.ready()
        .then((result) => json(response, result.status === 'ok' ? 200 : 503, result))
        .catch(() => json(response, 503, { status: 'unready' }));
      return;
    }
    if (path === '/metrics' && metrics) {
      try {
        collect?.();
        const body = metrics.render();
        response.writeHead(200, {
          'content-type': 'text/plain; version=0.0.4; charset=utf-8',
          'content-length': Buffer.byteLength(body),
          'cache-control': 'no-store'
        });
        response.end(body);
      } catch {
        json(response, 500, { error: { code: 'METRICS_RENDER_FAILED', status: 500 } });
      }
      return;
    }

    json(response, 404, { error: { code: 'NOT_FOUND', status: 404 } });
  });

  server.headersTimeout = headersTimeoutMs;
  server.requestTimeout = requestTimeoutMs;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return {
    server,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          logger.info?.('Ops server listening', { port, host });
          resolve();
        });
      });
      return server;
    },
    /** Closes listeners and destroys idle sockets so the pod can exit cleanly. */
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) {
          socket.destroy();
        }
        sockets.clear();
      });
    }
  };
}
