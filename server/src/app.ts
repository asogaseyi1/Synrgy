import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { config } from './config.ts';
import { pool } from './db.ts';
import { errorHandler, notFound } from './lib/errors.ts';
import { errorFields, log, requestLogger } from './lib/logger.ts';
import { pendingMigrations } from './migrate.ts';
import { loadSession, requireAuth } from './middleware/auth.ts';
import { bodyField, csrfProtection, rateLimit } from './middleware/security.ts';
import { announcementsRouter } from './routes/announcements.ts';
import { authRouter } from './routes/auth.ts';
import { invitationsRouter, membersRouter } from './routes/members.ts';
import { exceptionsRouter } from './routes/exceptions.ts';
import { organizationRouter } from './routes/organization.ts';
import { publicReportsRouter, reportsRouter } from './routes/reports.ts';
import { shiftsRouter } from './routes/shifts.ts';
import { swapsRouter } from './routes/swaps.ts';
import { timeRouter } from './routes/time.ts';

export function createApp(opts: { staticDir?: string } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(requestLogger);
  app.use(
    helmet({
      // Over plain http (local production try-outs) these would break the page.
      strictTransportSecurity: config.https,
      contentSecurityPolicy: {
        directives: {
          'upgrade-insecure-requests': config.https ? [] : null,
          'worker-src': ["'self'"],
          'manifest-src': ["'self'"],
        },
      },
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use('/api', csrfProtection);

  // Brute-force and abuse limits (in memory; keys are salted hashes, never raw IPs).
  const MIN = 60_000;
  const account = (req: express.Request) => `${bodyField('workspace')(req)}|${bodyField('email')(req)}`;
  app.use('/api/auth/login', rateLimit('login-ip', 30, 15 * MIN), rateLimit('login-account', 10, 15 * MIN, account));
  app.use('/api/auth/register-organization', rateLimit('register', 10, 60 * MIN));
  app.use('/api/auth/password-reset', rateLimit('reset-ip', 10, 15 * MIN));
  app.post('/api/auth/password-reset', rateLimit('reset-account', 3, 60 * MIN, account));
  app.use('/api/auth/password', rateLimit('password-change', 10, 15 * MIN));
  app.use('/api/invitations', rateLimit('invite-accept', 30, 15 * MIN));
  app.post('/api/public/reports/orgs/:slug/reports', rateLimit('report-submit', 10, 60 * MIN));
  app.use(['/api/public/reports/access', '/api/public/reports/messages'], rateLimit('report-access', 30, 15 * MIN));

  /** Liveness: the process is up. */
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  /** Readiness: the database answers and the schema is current. */
  app.get('/api/health/ready', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      const pending = await pendingMigrations(pool);
      if (pending.length) {
        res.status(503).json({ ok: false, reason: 'migrations_pending', pending });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      log.warn('readiness check failed', errorFields(err));
      res.status(503).json({ ok: false, reason: 'database_unavailable' });
    }
  });

  // Anonymous reporting is mounted before session loading on purpose: these handlers
  // must never learn who is signed in. See routes/reports.ts.
  app.use('/api/public/reports', publicReportsRouter);

  app.use('/api', loadSession);
  app.use('/api/auth', authRouter);
  app.use('/api/invitations', invitationsRouter);
  app.use('/api/members', requireAuth, membersRouter);
  app.use('/api/time', requireAuth, timeRouter);
  app.use('/api/exceptions', requireAuth, exceptionsRouter);
  app.use('/api/organization', requireAuth, organizationRouter);
  app.use('/api/shifts', requireAuth, shiftsRouter);
  app.use('/api/swaps', requireAuth, swapsRouter);
  app.use('/api/announcements', requireAuth, announcementsRouter);
  app.use('/api/reports', requireAuth, reportsRouter);

  app.use('/api', () => {
    throw notFound('No such endpoint');
  });

  // Production: serve the built web app from the same origin (no CORS, one deployable).
  const staticDir = opts.staticDir ?? config.staticDir;
  if (staticDir) serveClient(app, path.resolve(staticDir));

  app.use(errorHandler);
  return app;
}

function serveClient(app: express.Express, dir: string) {
  const index = path.join(dir, 'index.html');
  if (!existsSync(index)) {
    log.warn('STATIC_DIR has no index.html; the web app will not be served', { dir });
    return;
  }
  // Hashed build assets never change: cache for a year. Everything else revalidates.
  app.use(
    '/assets',
    express.static(path.join(dir, 'assets'), { immutable: true, maxAge: '365d', index: false, fallthrough: false }),
  );
  app.use(
    express.static(dir, {
      index: false,
      setHeaders: (res, file) => {
        res.set('Cache-Control', 'no-cache');
        // The service worker must be allowed to control the whole site.
        if (file.endsWith('sw.js')) res.set('Service-Worker-Allowed', '/');
      },
    }),
  );
  // Client-side routes: any other GET that accepts HTML gets the app shell.
  app.get(/^\/(?!api\/).*/, (req, res, next) => {
    if (!req.accepts('html')) return next();
    res.set('Cache-Control', 'no-cache');
    res.sendFile(index);
  });
}
