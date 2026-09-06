import { createError, normalizeError } from '../shared/errors.js';
import { ChannelAdapter } from '../notifications/mock-adapter.js';
import { DELIVERY_STATUS } from '../notifications/types.js';

/**
 * Concrete channel adapter that POSTs a rendered notification to an HTTP
 * provider (SendGrid-style transactional APIs, SMS gateways, push relays, or an
 * app's own webhook). Downstream repos usually only need to supply `endpoint`,
 * `headers`, and an optional `transform` for the provider payload shape.
 */
export class HttpChannelAdapter extends ChannelAdapter {
  constructor({ channel, endpoint, headers = {}, fetchImpl = globalThis.fetch, transform, timeoutMs } = {}) {
    super({ channel });
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
      throw createError('NOTIFICATION_ADAPTER_MISCONFIGURED', 'HttpChannelAdapter requires an endpoint', { status: 500 });
    }
    if (typeof fetchImpl !== 'function') {
      throw createError('NOTIFICATION_ADAPTER_MISCONFIGURED', 'HttpChannelAdapter requires a fetch implementation', { status: 500 });
    }
    if (transform !== undefined && typeof transform !== 'function') {
      throw createError('NOTIFICATION_ADAPTER_MISCONFIGURED', 'HttpChannelAdapter transform must be a function', { status: 500 });
    }

    this.endpoint = endpoint;
    this.headers = headers;
    this.fetchImpl = fetchImpl;
    this.transform = transform;
    this.timeoutMs = timeoutMs;
  }

  async send(message) {
    const payload = this.transform ? this.transform(message) : message;
    const response = await this.#post(payload);
    if (!response?.ok) {
      throw createError('NOTIFICATION_PROVIDER_ERROR', `${this.channel ?? 'provider'} responded with ${response?.status ?? 'no status'}`, {
        status: 502,
        details: { channel: this.channel, providerStatus: response?.status }
      });
    }

    return {
      channel: this.channel,
      status: DELIVERY_STATUS.SENT,
      providerMessageId: await readProviderMessageId(response),
      sentAt: new Date().toISOString()
    };
  }

  async #post(payload) {
    const signal = this.timeoutMs === undefined ? undefined : AbortSignal.timeout(this.timeoutMs);
    try {
      return await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers },
        body: JSON.stringify(payload),
        signal
      });
    } catch (error) {
      throw createError('NOTIFICATION_PROVIDER_UNREACHABLE', `${this.channel ?? 'provider'} request failed`, {
        status: 502,
        details: { channel: this.channel },
        cause: normalizeError(error)
      });
    }
  }
}

async function readProviderMessageId(response) {
  const header = response.headers?.get?.('x-message-id');
  if (header) {
    return header;
  }
  if (typeof response.json !== 'function') {
    return undefined;
  }

  try {
    const body = await response.json();
    return body?.id ?? body?.messageId ?? undefined;
  } catch {
    return undefined;
  }
}
