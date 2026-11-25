import { config } from './config.ts';
import { createApp } from './app.ts';
import { pool } from './db.ts';
import { startJobs } from './lib/jobs.ts';
import { flushMail } from './lib/mailer.ts';
import { errorFields, log } from './lib/logger.ts';
import { migrate } from './migrate.ts';

if (process.env.MIGRATE_ON_START === 'true') {
  await migrate(config.databaseUrl, (msg) => log.info(msg));
}

const server = createApp().listen(config.port, () => {
  log.info('listening', {
    port: config.port,
    env: config.env,
    mail: config.mailProvider,
    serving: config.staticDir || 'api only',
    https: config.https,
  });
  if (config.isProd && config.mailProvider === 'none') log.warn('MAIL_PROVIDER is not set; no email will be sent');
  if (config.isProd && config.mailProvider === 'console') log.warn('MAIL_PROVIDER=console logs email contents (incl. reset links)');
  startJobs();
});

// Stop accepting connections, let in-flight requests and queued email finish, then close the pool.
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info('shutting down', { signal });
  const force = setTimeout(() => process.exit(1), 10_000).unref();
  server.close(async () => {
    await flushMail().catch(() => {});
    await pool.end().catch(() => {});
    clearTimeout(force);
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log.error('unhandled rejection', errorFields(err)));
