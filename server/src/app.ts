import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { errorHandler, notFound } from './lib/errors.ts';
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

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
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

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
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
  app.use(errorHandler);
  return app;
}
