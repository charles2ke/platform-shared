export class PlatformError extends Error {
  constructor({ code, message, status = 500, details, cause }) {
    super(message, { cause });
    this.name = 'PlatformError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        status: this.status,
        details: this.details
      }
    };
  }
}

export function createError(code, message, options = {}) {
  return new PlatformError({ code, message, ...options });
}

export function normalizeError(error, fallbackCode = 'PLATFORM_ERROR') {
  if (error instanceof PlatformError) {
    return error;
  }

  return new PlatformError({
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    cause: error
  });
}
