function numberFromEnv(value, fallback) {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(env = process.env) {
  return {
    environment: env.PLATFORM_ENV ?? env.NODE_ENV ?? 'development',
    auth: {
      jwtSecret: env.PLATFORM_JWT_SECRET,
      issuer: env.PLATFORM_JWT_ISSUER ?? 'platform-shared',
      audience: env.PLATFORM_JWT_AUDIENCE,
      accessTokenTtlSeconds: numberFromEnv(env.PLATFORM_JWT_ACCESS_TTL_SECONDS, 900),
      refreshTokenTtlSeconds: numberFromEnv(env.PLATFORM_JWT_REFRESH_TTL_SECONDS, 2_592_000)
    },
    notifications: {
      defaultFromEmail: env.PLATFORM_DEFAULT_FROM_EMAIL,
      defaultSmsSender: env.PLATFORM_DEFAULT_SMS_SENDER,
      defaultPushSender: env.PLATFORM_DEFAULT_PUSH_SENDER
    },
    profile: {
      defaultLocale: env.PLATFORM_DEFAULT_LOCALE ?? 'en-US',
      defaultTimezone: env.PLATFORM_DEFAULT_TIMEZONE ?? 'UTC'
    }
  };
}

export function requireJwtSecret(config) {
  const secret = config?.auth?.jwtSecret;
  if (!secret || secret.length < 32) {
    throw new Error('PLATFORM_JWT_SECRET must be set to at least 32 characters');
  }
  return secret;
}
