import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config } from '../config.ts';
import { pool, tx, isUniqueViolation } from '../db.ts';
import { conflict, parse, unauthorized } from '../lib/errors.ts';
import { getUser, isValidTimezone } from '../lib/users.ts';
import { auth, endSession, requireAuth, startSession } from '../middleware/auth.ts';

export const authRouter = Router();

const email = z.email().trim().toLowerCase();
const password = z.string().min(8, 'Use at least 8 characters').max(200);
const name = z.string().trim().min(1).max(100);

const registerSchema = z.object({
  organizationName: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$/, 'Use 3-40 lowercase letters, numbers or dashes'),
  timezone: z.string().refine(isValidTimezone, 'Unknown time zone').default('UTC'),
  firstName: name,
  lastName: name,
  email,
  password,
});

// A fixed hash so login takes the same time whether or not the email exists.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', config.bcryptRounds);

authRouter.post('/register-organization', async (req, res) => {
  const body = parse(registerSchema, req.body);
  const passwordHash = await bcrypt.hash(body.password, config.bcryptRounds);
  try {
    const result = await tx(async (db) => {
      const org = await db.query(
        'INSERT INTO organizations (name, slug, timezone) VALUES ($1, $2, $3) RETURNING id, name, slug, timezone',
        [body.organizationName, body.slug, body.timezone],
      );
      const organization = org.rows[0];
      const user = await db.query(
        `INSERT INTO users (organization_id, email, password_hash, first_name, last_name, role, can_review_reports)
         VALUES ($1, $2, $3, $4, $5, 'owner', true) RETURNING id`,
        [organization.id, body.email, passwordHash, body.firstName, body.lastName],
      );
      await startSession(db, res, user.rows[0].id);
      return { organization, user: await getUser(db, organization.id, user.rows[0].id) };
    });
    res.status(201).json(result);
  } catch (err) {
    if (isUniqueViolation(err, 'organizations_slug_key')) {
      throw conflict('slug_taken', 'That workspace URL is already taken');
    }
    throw err;
  }
});

const loginSchema = z.object({ workspace: z.string().trim().toLowerCase().min(1), email, password: z.string() });

authRouter.post('/login', async (req, res) => {
  const body = parse(loginSchema, req.body);
  const { rows } = await pool.query(
    `SELECT u.id, u.password_hash, u.status FROM users u JOIN organizations o ON o.id = u.organization_id
      WHERE o.slug = $1 AND lower(u.email) = $2`,
    [body.workspace, body.email],
  );
  const row = rows[0];
  const ok = await bcrypt.compare(body.password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !ok || row.status !== 'active') throw unauthorized('Incorrect workspace, email or password');
  await startSession(pool, res, row.id);
  res.json(await loadMe(row.id));
});

authRouter.post('/logout', async (req, res) => {
  await endSession(req, res);
  res.status(204).end();
});

authRouter.get('/me', requireAuth, async (req, res) => {
  res.json(await loadMe(auth(req).userId));
});

async function loadMe(userId: string) {
  const { rows } = await pool.query(
    `SELECT o.id, o.name, o.slug, o.timezone, u.organization_id FROM users u
       JOIN organizations o ON o.id = u.organization_id WHERE u.id = $1`,
    [userId],
  );
  const { organization_id, ...organization } = rows[0];
  return { organization, user: await getUser(pool, organization_id, userId) };
}
