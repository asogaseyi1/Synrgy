const env = process.env;

export const config = {
  env: env.NODE_ENV ?? 'development',
  port: Number(env.PORT ?? 4000),
  databaseUrl: env.DATABASE_URL ?? 'postgres://synrgy:synrgy@localhost:5432/synrgy',
  clientOrigin: env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  sessionTtlDays: Number(env.SESSION_TTL_DAYS ?? 7),
  inviteTtlDays: Number(env.INVITE_TTL_DAYS ?? 7),
  bcryptRounds: Number(env.BCRYPT_ROUNDS ?? 12),
  get isProd() {
    return this.env === 'production';
  },
};
