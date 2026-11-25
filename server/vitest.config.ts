import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    env: {
      NODE_ENV: 'test',
      BCRYPT_ROUNDS: '4',
      RATE_LIMITS: 'off',
      MAIL_PROVIDER: 'memory',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://synrgy:synrgy@localhost:5432/synrgy_test',
    },
    fileParallelism: false,
  },
});
