import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { errorHandler, notFound } from './lib/errors.ts';
import { loadSession, requireAuth } from './middleware/auth.ts';
import { authRouter } from './routes/auth.ts';
import { invitationsRouter, membersRouter } from './routes/members.ts';
import { exceptionsRouter } from './routes/exceptions.ts';
import { organizationRouter } from './routes/organization.ts';
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

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api', loadSession);
  app.use('/api/auth', authRouter);
  app.use('/api/invitations', invitationsRouter);
  app.use('/api/members', requireAuth, membersRouter);
  app.use('/api/time', requireAuth, timeRouter);
  app.use('/api/exceptions', requireAuth, exceptionsRouter);
  app.use('/api/organization', requireAuth, organizationRouter);
  app.use('/api/shifts', requireAuth, shiftsRouter);
  app.use('/api/swaps', requireAuth, swapsRouter);

  app.use('/api', () => {
    throw notFound('No such endpoint');
  });
  app.use(errorHandler);
  return app;
}
