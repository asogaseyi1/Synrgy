import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config } from '../config.ts';
import { pool, tx } from '../db.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, conflict, forbidden, notFound, parse } from '../lib/errors.ts';
import { appLink } from '../lib/mailer.ts';
import { invitationEmail } from '../lib/notify.ts';
import { hashToken, newToken } from '../lib/tokens.ts';
import { getUser, USER_COLUMNS } from '../lib/users.ts';
import { atLeast, auth, requireRole, startSession } from '../middleware/auth.ts';

export const membersRouter = Router();

membersRouter.get('/', requireRole('manager'), async (req, res) => {
  const { organizationId } = auth(req);
  const { rows } = await pool.query(
    `SELECT ${USER_COLUMNS} FROM users u WHERE u.organization_id = $1 ORDER BY u.last_name, u.first_name`,
    [organizationId],
  );
  res.json({ members: rows });
});

const inviteSchema = z.object({
  email: z.email().trim().toLowerCase(),
  role: z.enum(['admin', 'manager', 'employee']).default('employee'),
});

membersRouter.post('/invitations', requireRole('admin'), async (req, res) => {
  const me = auth(req);
  const body = parse(inviteSchema, req.body);
  if (body.role === 'admin' && me.role !== 'owner') throw forbidden('Only the owner can invite admins');

  const existing = await pool.query(
    'SELECT 1 FROM users WHERE organization_id = $1 AND lower(email) = $2',
    [me.organizationId, body.email],
  );
  if (existing.rowCount) throw conflict('already_member', 'That person is already a member');

  const token = newToken();
  const expiresAt = new Date(Date.now() + config.inviteTtlDays * 86_400_000);
  const { rows } = await pool.query(
    `INSERT INTO invitations (organization_id, email, role, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, role, expires_at AS "expiresAt"`,
    [me.organizationId, body.email, body.role, hashToken(token), me.userId, expiresAt],
  );
  const acceptUrl = appLink(`/invite/${token}`);
  const ctx = await pool.query(
    `SELECT o.name, u.first_name || ' ' || u.last_name AS inviter FROM organizations o, users u WHERE o.id = $1 AND u.id = $2`,
    [me.organizationId, me.userId],
  );
  invitationEmail(body.email, ctx.rows[0].name, ctx.rows[0].inviter, acceptUrl);
  // The link is also returned so admins can share it directly when email isn't set up.
  res.status(201).json({ invitation: rows[0], token, acceptUrl, emailed: config.mailProvider !== 'none' });
});

membersRouter.get('/invitations', requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, email, role, expires_at AS "expiresAt", created_at AS "createdAt" FROM invitations
      WHERE organization_id = $1 AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
    [auth(req).organizationId],
  );
  res.json({ invitations: rows });
});

membersRouter.delete('/invitations/:id', requireRole('admin'), async (req, res) => {
  await pool.query('DELETE FROM invitations WHERE organization_id = $1 AND id = $2 AND accepted_at IS NULL', [
    auth(req).organizationId,
    req.params.id,
  ]);
  res.status(204).end();
});

const updateSchema = z
  .object({
    role: z.enum(['admin', 'manager', 'employee']),
    managerId: z.uuid().nullable(),
    canReviewReports: z.boolean(),
    status: z.enum(['active', 'deactivated']),
    departmentId: z.uuid().nullable(),
    locationId: z.uuid().nullable(),
  })
  .partial();

membersRouter.patch('/:id', requireRole('admin'), async (req, res) => {
  const me = auth(req);
  const body = parse(updateSchema, req.body);
  const id = parse(z.uuid(), req.params.id);

  const updated = await tx(async (db) => {
    const target = await getUser(db, me.organizationId, id);
    if (!target) throw notFound('Member not found');
    if (target.role === 'owner' && me.role !== 'owner') throw forbidden('Only the owner can change the owner');
    if (target.role === 'owner' && body.role) throw badRequest("The owner's role can't be changed");
    if (target.role === 'admin' && !atLeast(me.role, 'owner')) throw forbidden('Only the owner can change admins');
    if (body.role === 'admin' && me.role !== 'owner') throw forbidden('Only the owner can grant admin');
    if (id === me.userId && body.status === 'deactivated') throw badRequest("You can't deactivate yourself");
    if (body.managerId) {
      if (body.managerId === id) throw badRequest("Someone can't be their own manager");
      const manager = await getUser(db, me.organizationId, body.managerId);
      if (!manager || !atLeast(manager.role, 'manager')) throw badRequest('Manager must be a manager or above');
    }

    for (const [field, kind] of [['departmentId', 'department'], ['locationId', 'location']] as const) {
      const unitId = body[field];
      if (!unitId) continue;
      const ok = await db.query('SELECT 1 FROM org_units WHERE id = $1 AND organization_id = $2 AND kind = $3', [unitId, me.organizationId, kind]);
      if (!ok.rowCount) throw badRequest(`Unknown ${kind}`);
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    const set = (col: string, val: unknown) => {
      values.push(val);
      sets.push(`${col} = $${values.length}`);
    };
    if (body.role !== undefined) set('role', body.role);
    if (body.managerId !== undefined) set('manager_id', body.managerId);
    if (body.canReviewReports !== undefined) set('can_review_reports', body.canReviewReports);
    if (body.status !== undefined) set('status', body.status);
    if (body.departmentId !== undefined) set('department_id', body.departmentId);
    if (body.locationId !== undefined) set('location_id', body.locationId);
    if (!sets.length) return target;

    values.push(me.organizationId, id);
    await db.query(
      `UPDATE users SET ${sets.join(', ')} WHERE organization_id = $${values.length - 1} AND id = $${values.length}`,
      values,
    );
    if (body.status === 'deactivated') await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    await audit(db, {
      organizationId: me.organizationId,
      actorId: me.userId,
      action: 'member.updated',
      entity: 'user',
      entityId: id,
      data: body,
    });
    return getUser(db, me.organizationId, id);
  });
  res.json({ member: updated });
});

// ---- Public invitation endpoints (mounted at /api/invitations) ----

export const invitationsRouter = Router();

async function findInvite(token: string) {
  const { rows } = await pool.query(
    `SELECT i.id, i.email, i.role, i.organization_id, o.name AS "organizationName", o.slug AS "organizationSlug"
       FROM invitations i JOIN organizations o ON o.id = i.organization_id
      WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.expires_at > now()`,
    [hashToken(token)],
  );
  if (!rows[0]) throw notFound('This invitation is invalid or has expired');
  return rows[0];
}

invitationsRouter.get('/:token', async (req, res) => {
  const { id: _id, organization_id: _org, ...invite } = await findInvite(req.params.token);
  res.json({ invitation: invite });
});

const acceptSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  password: z.string().min(8, 'Use at least 8 characters').max(200),
});

invitationsRouter.post('/:token/accept', async (req, res) => {
  const body = parse(acceptSchema, req.body);
  const invite = await findInvite(req.params.token);
  const passwordHash = await bcrypt.hash(body.password, config.bcryptRounds);
  const user = await tx(async (db) => {
    const claimed = await db.query(
      'UPDATE invitations SET accepted_at = now() WHERE id = $1 AND accepted_at IS NULL',
      [invite.id],
    );
    if (!claimed.rowCount) throw conflict('invite_used', 'This invitation was already used');
    const { rows } = await db.query(
      `INSERT INTO users (organization_id, email, password_hash, first_name, last_name, role)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [invite.organization_id, invite.email, passwordHash, body.firstName, body.lastName, invite.role],
    );
    await startSession(db, res, rows[0].id);
    return getUser(db, invite.organization_id, rows[0].id);
  });
  res.status(201).json({ user });
});
