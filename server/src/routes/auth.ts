import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config } from '../config.ts';
import { pool, tx, isUniqueViolation, type Queryable } from '../db.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, conflict, notFound, parse, unauthorized } from '../lib/errors.ts';
import { appLink } from '../lib/mailer.ts';
import { passwordResetEmail } from '../lib/notify.ts';
import { hashToken, newToken } from '../lib/tokens.ts';
import { getUser, isValidTimezone } from '../lib/users.ts';
import { auth, endSession, requireAuth, SESSION_COOKIE, startSession } from '../middleware/auth.ts';

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
    `SELECT o.id, o.name, o.slug, o.timezone, COALESCE((o.settings->>'weekStartsOn')::int, 1) AS "weekStartsOn",
            u.organization_id FROM users u
       JOIN organizations o ON o.id = u.organization_id WHERE u.id = $1`,
    [userId],
  );
  const { organization_id, ...organization } = rows[0];
  return { organization, user: await getUser(pool, organization_id, userId) };
}

// ---- Account ----

const profileSchema = z.object({ firstName: name, lastName: name, emailNotifications: z.boolean() }).partial();

authRouter.patch('/me', requireAuth, async (req, res) => {
  const me = auth(req);
  const body = parse(profileSchema, req.body);
  await pool.query(
    `UPDATE users SET first_name = COALESCE($2, first_name), last_name = COALESCE($3, last_name),
            email_notifications = COALESCE($4, email_notifications) WHERE id = $1`,
    [me.userId, body.firstName ?? null, body.lastName ?? null, body.emailNotifications ?? null],
  );
  res.json(await loadMe(me.userId));
});

/** Change password while signed in. Signs out every other session. */
authRouter.post('/password', requireAuth, async (req, res) => {
  const me = auth(req);
  const body = parse(z.object({ currentPassword: z.string(), newPassword: password }), req.body);
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [me.userId]);
  if (!(await bcrypt.compare(body.currentPassword, rows[0].password_hash))) {
    throw badRequest('Your current password is incorrect', { currentPassword: ['Incorrect password'] });
  }
  const hash = await bcrypt.hash(body.newPassword, config.bcryptRounds);
  await tx(async (db) => {
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [me.userId, hash]);
    await db.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [me.userId, hashToken(req.cookies[SESSION_COOKIE])]);
    await db.query('DELETE FROM password_resets WHERE user_id = $1', [me.userId]);
    await audit(db, { organizationId: me.organizationId, actorId: me.userId, action: 'user.password_changed', entity: 'user', entityId: me.userId });
  });
  res.status(204).end();
});

// ---- Password reset (signed out) ----

const resetRequestSchema = z.object({ workspace: z.string().trim().toLowerCase().min(1).max(60), email });

/** Always answers the same way, so it can't be used to discover who has an account. */
authRouter.post('/password-reset', async (req, res) => {
  const body = parse(resetRequestSchema, req.body);
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.first_name, o.name AS org FROM users u JOIN organizations o ON o.id = u.organization_id
      WHERE o.slug = $1 AND lower(u.email) = $2 AND u.status = 'active'`,
    [body.workspace, body.email],
  );
  const user = rows[0];
  if (user) {
    const token = newToken();
    await pool.query('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
      hashToken(token),
      user.id,
      new Date(Date.now() + config.passwordResetTtlMinutes * 60_000),
    ]);
    passwordResetEmail(user.email, user.first_name, user.org, appLink(`/reset/${token}`), config.passwordResetTtlMinutes);
  }
  res.json({ ok: true });
});

async function findReset(db: Queryable, token: string, lock = false) {
  const { rows } = await db.query(
    `SELECT pr.token_hash, u.id AS user_id, u.organization_id, u.first_name, o.name AS org
       FROM password_resets pr JOIN users u ON u.id = pr.user_id JOIN organizations o ON o.id = u.organization_id
      WHERE pr.token_hash = $1 AND pr.used_at IS NULL AND pr.expires_at > now() AND u.status = 'active'
      ${lock ? 'FOR UPDATE OF pr' : ''}`,
    [hashToken(token)],
  );
  if (!rows[0]) throw notFound('This reset link is invalid or has expired. Request a new one.');
  return rows[0];
}

authRouter.get('/password-reset/:token', async (req, res) => {
  const r = await findReset(pool, req.params.token);
  res.json({ firstName: r.first_name, organizationName: r.org });
});

authRouter.post('/password-reset/:token', async (req, res) => {
  const body = parse(z.object({ password }), req.body);
  const hash = await bcrypt.hash(body.password, config.bcryptRounds);
  const userId = await tx(async (db) => {
    const r = await findReset(db, req.params.token, true);
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [r.user_id, hash]);
    await db.query('UPDATE password_resets SET used_at = now() WHERE token_hash = $1', [r.token_hash]);
    await db.query('DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL', [r.user_id]);
    await db.query('DELETE FROM sessions WHERE user_id = $1', [r.user_id]); // sign out everywhere
    await audit(db, { organizationId: r.organization_id, actorId: r.user_id, action: 'user.password_reset', entity: 'user', entityId: r.user_id });
    await startSession(db, res, r.user_id);
    return r.user_id as string;
  });
  res.json(await loadMe(userId));
});
