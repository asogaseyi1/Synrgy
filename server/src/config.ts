const env = process.env;

export const config = {
  env: env.NODE_ENV ?? 'development',
  port: Number(env.PORT ?? 4000),
  databaseUrl: env.DATABASE_URL ?? 'postgres://synrgy:synrgy@localhost:5432/synrgy',
  clientOrigin: env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  sessionTtlDays: Number(env.SESSION_TTL_DAYS ?? 7),
  inviteTtlDays: Number(env.INVITE_TTL_DAYS ?? 7),
  bcryptRounds: Number(env.BCRYPT_ROUNDS ?? 12),
  /** Public URL of the web app, used in emailed links. */
  appUrl: env.APP_URL ?? env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  /** console (dev default) | memory (tests) | resend | webhook | none (production default). */
  mailProvider: env.MAIL_PROVIDER ?? (env.NODE_ENV === 'test' ? 'memory' : env.NODE_ENV === 'production' ? 'none' : 'console'),
  mailFrom: env.MAIL_FROM ?? 'Synrgy <no-reply@synrgy.local>',
  resendApiKey: env.RESEND_API_KEY ?? '',
  mailWebhookUrl: env.MAIL_WEBHOOK_URL ?? '',
  /** Set RATE_LIMITS=off to disable (the test suite does). */
  rateLimits: (env.RATE_LIMITS ?? 'on') !== 'off',
  /** Extra allowed browser origins for state-changing requests, comma-separated. */
  allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  passwordResetTtlMinutes: Number(env.PASSWORD_RESET_TTL_MINUTES ?? 60),
  logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'error' : 'info'),
  /** json (production default) | pretty */
  logFormat: env.LOG_FORMAT ?? (env.NODE_ENV === 'production' ? 'json' : 'pretty'),
  /** Built web app to serve (production). Empty = don't serve static files. */
  staticDir: env.STATIC_DIR ?? '',
  /**
   * The app is reached over HTTPS: Secure cookies, HSTS, upgrade-insecure-requests.
   * Defaults to on in production; set HTTPS=false to try a production build over plain http://localhost.
   */
  get https() {
    return env.HTTPS ? env.HTTPS !== 'false' : this.isProd;
  },
  get isProd() {
    return this.env === 'production';
  },
};
