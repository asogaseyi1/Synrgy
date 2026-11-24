import { Router } from 'express';
import { z } from 'zod';
import { pool, tx, type Queryable } from '../db.ts';
import { canSchedule } from '../lib/access.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, forbidden, notFound, parse } from '../lib/errors.ts';
import { atLeast, auth, requireRole, type AuthContext } from '../middleware/auth.ts';

export const shiftsRouter = Router();

const DAY = 86_400_000;
const MAX_RANGE_DAYS = 62;
const isoDate = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => s || null)
    .nullable()
    .optional();

export const SHIFT_SELECT = `
  SELECT s.id, s.starts_at AS "startsAt", s.ends_at AS "endsAt", s.position, s.location, s.notes,
         s.published_at IS NULL AS "isDraft",
         CASE WHEN u.id IS NULL THEN NULL
              ELSE json_build_object('id', u.id, 'firstName', u.first_name, 'lastName', u.last_name) END AS "user",
         (SELECT json_build_object('id', sw.id, 'type', sw.type, 'status', sw.status)
            FROM shift_swaps sw
           WHERE (sw.shift_id = s.id OR sw.target_shift_id = s.id)
             AND sw.status IN ('pending_peer', 'pending_manager') LIMIT 1) AS "activeSwap"
    FROM scheduled_shifts s
    LEFT JOIN users u ON u.id = s.user_id`;

export async function loadShift(db: Queryable, organizationId: string, id: string) {
  const { rows } = await db.query(`${SHIFT_SELECT} WHERE s.organization_id = $1 AND s.id = $2`, [organizationId, id]);
  return rows[0] ?? null;
}

/**
 * Managers see drafts for shifts they can schedule; everyone sees published shifts.
 * Pushes any needed parameter onto `values`.
 */
function visibilityClause(me: AuthContext, values: unknown[]) {
  if (atLeast(me.role, 'admin')) return 'TRUE';
  if (me.role === 'manager') {
    values.push(me.userId);
    const p = `$${values.length}`;
    return `(s.published_at IS NOT NULL OR s.user_id IS NULL OR s.user_id = ${p} OR u.manager_id = ${p})`;
  }
  return 's.published_at IS NOT NULL';
}

const rangeSchema = z
  .object({ from: isoDate, to: isoDate })
  .refine((r) => r.from < r.to, 'from must be before to')
  .refine((r) => r.to.getTime() - r.from.getTime() <= MAX_RANGE_DAYS * DAY, `Range can be at most ${MAX_RANGE_DAYS} days`);

shiftsRouter.get('/', async (req, res) => {
  const me = auth(req);
  const range = parse(rangeSchema, req.query);
  const values: unknown[] = [me.organizationId, range.from, range.to];
  const visible = visibilityClause(me, values);
  const { rows } = await pool.query(
    `${SHIFT_SELECT}
      WHERE s.organization_id = $1 AND s.starts_at < $3 AND s.ends_at > $2 AND ${visible}
      ORDER BY s.starts_at, u.last_name NULLS FIRST`,
    values,
  );
  res.json({ shifts: rows });
});

/** My upcoming published shifts (for the clock page). */
shiftsRouter.get('/upcoming', async (req, res) => {
  const me = auth(req);
  const { rows } = await pool.query(
    `${SHIFT_SELECT}
      WHERE s.organization_id = $1 AND s.user_id = $2 AND s.published_at IS NOT NULL AND s.ends_at > now()
      ORDER BY s.starts_at LIMIT 5`,
    [me.organizationId, me.userId],
  );
  res.json({ shifts: rows });
});

const shiftSchema = z.object({
  userId: z.uuid().nullable().default(null),
  startsAt: isoDate,
  endsAt: isoDate,
  position: optionalText(80),
  location: optionalText(120),
  notes: optionalText(500),
});

function validateTimes(startsAt: Date, endsAt: Date) {
  if (endsAt <= startsAt) throw badRequest('A shift must end after it starts');
  if (endsAt.getTime() - startsAt.getTime() > DAY) throw badRequest("A shift can't be longer than 24 hours");
}

async function assertAssignable(db: Queryable, me: AuthContext, userId: string | null) {
  if (userId) {
    const { rowCount } = await db.query(
      "SELECT 1 FROM users WHERE id = $1 AND organization_id = $2 AND status = 'active'",
      [userId, me.organizationId],
    );
    if (!rowCount) throw badRequest('That person is not an active member');
  }
  if (!(await canSchedule(db, me, userId))) throw forbidden("You can't schedule this person");
}

shiftsRouter.post('/', requireRole('manager'), async (req, res) => {
  const me = auth(req);
  const body = parse(shiftSchema, req.body);
  validateTimes(body.startsAt, body.endsAt);
  await assertAssignable(pool, me, body.userId);
  const { rows } = await pool.query(
    `INSERT INTO scheduled_shifts (organization_id, user_id, starts_at, ends_at, position, location, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [me.organizationId, body.userId, body.startsAt, body.endsAt, body.position ?? null, body.location ?? null, body.notes ?? null, me.userId],
  );
  res.status(201).json({ shift: await loadShift(pool, me.organizationId, rows[0].id) });
});

/** Shifts a manager may edit: existing assignee must be in their scope. */
async function lockEditable(db: Queryable, me: AuthContext, id: string) {
  const { rows } = await db.query(
    'SELECT * FROM scheduled_shifts WHERE id = $1 AND organization_id = $2 FOR UPDATE',
    [id, me.organizationId],
  );
  const shift = rows[0];
  if (!shift) throw notFound('Shift not found');
  if (!(await canSchedule(db, me, shift.user_id))) throw forbidden("You can't edit this shift");
  return shift;
}

/** Any edit to a shift invalidates pending swap requests that involve it. */
async function cancelActiveSwaps(db: Queryable, shiftId: string) {
  await db.query(
    `UPDATE shift_swaps SET status = 'cancelled', review_note = 'Shift was changed by a manager'
      WHERE (shift_id = $1 OR target_shift_id = $1) AND status IN ('pending_peer', 'pending_manager')`,
    [shiftId],
  );
}

shiftsRouter.patch('/:id', requireRole('manager'), async (req, res) => {
  const me = auth(req);
  const id = parse(z.uuid(), req.params.id);
  const patch = parse(shiftSchema.partial(), req.body);

  await tx(async (db) => {
    const current = await lockEditable(db, me, id);
    const next = {
      userId: patch.userId !== undefined ? patch.userId : current.user_id,
      startsAt: patch.startsAt ?? current.starts_at,
      endsAt: patch.endsAt ?? current.ends_at,
      position: patch.position !== undefined ? patch.position : current.position,
      location: patch.location !== undefined ? patch.location : current.location,
      notes: patch.notes !== undefined ? patch.notes : current.notes,
    };
    validateTimes(next.startsAt, next.endsAt);
    if (next.userId !== current.user_id) await assertAssignable(db, me, next.userId);
    await db.query(
      `UPDATE scheduled_shifts SET user_id = $2, starts_at = $3, ends_at = $4, position = $5, location = $6,
              notes = $7, updated_at = now() WHERE id = $1`,
      [id, next.userId, next.startsAt, next.endsAt, next.position, next.location, next.notes],
    );
    await cancelActiveSwaps(db, id);
    if (current.published_at) {
      await audit(db, {
        organizationId: me.organizationId,
        actorId: me.userId,
        action: 'shift.updated',
        entity: 'scheduled_shift',
        entityId: id,
        data: { before: { userId: current.user_id, startsAt: current.starts_at, endsAt: current.ends_at }, after: next },
      });
    }
  });
  res.json({ shift: await loadShift(pool, me.organizationId, id) });
});

shiftsRouter.delete('/:id', requireRole('manager'), async (req, res) => {
  const me = auth(req);
  const id = parse(z.uuid(), req.params.id);
  await tx(async (db) => {
    const current = await lockEditable(db, me, id);
    await db.query('DELETE FROM scheduled_shifts WHERE id = $1', [id]);
    if (current.published_at) {
      await audit(db, {
        organizationId: me.organizationId,
        actorId: me.userId,
        action: 'shift.deleted',
        entity: 'scheduled_shift',
        entityId: id,
        data: { userId: current.user_id, startsAt: current.starts_at, endsAt: current.ends_at },
      });
    }
  });
  res.status(204).end();
});

/** Publish every draft in the range that this manager is allowed to schedule. */
shiftsRouter.post('/publish', requireRole('manager'), async (req, res) => {
  const me = auth(req);
  const range = parse(rangeSchema, req.body);
  const scoped = !atLeast(me.role, 'admin');
  const { rowCount } = await pool.query(
    `UPDATE scheduled_shifts s SET published_at = now()
      WHERE s.organization_id = $1 AND s.published_at IS NULL AND s.starts_at >= $2 AND s.starts_at < $3
        AND ($4::uuid IS NULL OR s.user_id IS NULL OR s.user_id = $4
             OR EXISTS (SELECT 1 FROM users u WHERE u.id = s.user_id AND u.manager_id = $4))`,
    [me.organizationId, range.from, range.to, scoped ? me.userId : null],
  );
  res.json({ published: rowCount });
});
