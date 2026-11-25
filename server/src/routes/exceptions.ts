import { Router } from 'express';
import { z } from 'zod';
import { pool, tx, isUniqueViolation, type Queryable } from '../db.ts';
import { canReview } from '../lib/access.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, conflict, forbidden, notFound, parse } from '../lib/errors.ts';
import { exceptionDecided, exceptionSubmitted } from '../lib/notify.ts';
import { getSettings } from '../lib/settings.ts';
import { atLeast, auth } from '../middleware/auth.ts';

export const exceptionsRouter = Router();

// The correction window is an org setting (correctionWindowDays); the shift length cap is fixed.
export const MAX_SHIFT_HOURS = 24;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const isoDate = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

const breakSchema = z.object({
  startedAt: isoDate,
  endedAt: isoDate,
  kind: z.enum(['paid', 'unpaid']).default('unpaid'),
});

const createSchema = z.object({
  kind: z.enum(['missed_shift', 'missed_clock_in', 'missed_clock_out', 'missed_break', 'wrong_time']),
  workSessionId: z.uuid().optional(),
  clockInAt: isoDate,
  clockOutAt: isoDate,
  breaks: z.array(breakSchema).max(10).default([]),
  reason: z.string().trim().min(3, 'Please explain what happened').max(1000),
});

type Requested = Pick<z.infer<typeof createSchema>, 'clockInAt' | 'clockOutAt' | 'breaks'>;

/** Sanity rules for a proposed shift. Throws 400 with a readable message. */
function validateShape(r: Requested, windowDays: number) {
  const now = Date.now();
  if (r.clockOutAt <= r.clockInAt) throw badRequest('Clock-out must be after clock-in');
  if (r.clockOutAt.getTime() > now + 60_000) throw badRequest("Clock-out can't be in the future");
  if (r.clockInAt.getTime() < now - windowDays * DAY) {
    throw badRequest(`Corrections can only go back ${windowDays} days`);
  }
  if (r.clockOutAt.getTime() - r.clockInAt.getTime() > MAX_SHIFT_HOURS * HOUR) {
    throw badRequest(`A shift can't be longer than ${MAX_SHIFT_HOURS} hours`);
  }
  const sorted = [...r.breaks].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  sorted.forEach((b, i) => {
    if (b.endedAt <= b.startedAt) throw badRequest('Each break must end after it starts');
    if (b.startedAt < r.clockInAt || b.endedAt > r.clockOutAt) throw badRequest('Breaks must fall within the shift');
    if (i > 0 && b.startedAt < sorted[i - 1].endedAt) throw badRequest("Breaks can't overlap");
  });
  r.breaks = sorted;
}

/** Reject if the proposed shift would overlap another of the user's sessions. */
async function assertNoOverlap(db: Queryable, userId: string, r: Requested, excludeSessionId: string | null) {
  const { rowCount } = await db.query(
    `SELECT 1 FROM work_sessions
      WHERE user_id = $1 AND ($2::uuid IS NULL OR id <> $2)
        AND tstzrange(clock_in_at, COALESCE(clock_out_at, 'infinity')) && tstzrange($3, $4)`,
    [userId, excludeSessionId, r.clockInAt, r.clockOutAt],
  );
  if (rowCount) throw conflict('overlap', 'This overlaps another shift on your timesheet');
}

async function snapshotSession(db: Queryable, sessionId: string, lock = false) {
  const { rows } = await db.query(
    `SELECT ws.id, ws.user_id, ws.organization_id, ws.clock_in_at AS "clockInAt", ws.clock_out_at AS "clockOutAt",
            COALESCE((SELECT json_agg(json_build_object('startedAt', b.started_at, 'endedAt', b.ended_at, 'kind', b.kind)
                                      ORDER BY b.started_at)
                        FROM breaks b WHERE b.work_session_id = ws.id), '[]') AS breaks
       FROM work_sessions ws WHERE ws.id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [sessionId],
  );
  return rows[0] ?? null;
}

const EXCEPTION_SELECT = `
  SELECT pe.id, pe.kind, pe.status, pe.reason, pe.review_note AS "reviewNote", pe.reviewed_at AS "reviewedAt",
         pe.created_at AS "createdAt", pe.work_session_id AS "workSessionId", pe.original,
         json_build_object('clockInAt', pe.requested_clock_in_at, 'clockOutAt', pe.requested_clock_out_at,
                           'breaks', pe.requested_breaks) AS requested,
         json_build_object('id', u.id, 'firstName', u.first_name, 'lastName', u.last_name) AS "user",
         CASE WHEN r.id IS NULL THEN NULL
              ELSE json_build_object('id', r.id, 'firstName', r.first_name, 'lastName', r.last_name) END AS reviewer
    FROM punch_exceptions pe
    JOIN users u ON u.id = pe.user_id
    LEFT JOIN users r ON r.id = pe.reviewer_id`;

async function loadException(db: Queryable, organizationId: string, id: string) {
  const { rows } = await db.query(`${EXCEPTION_SELECT} WHERE pe.organization_id = $1 AND pe.id = $2`, [
    organizationId,
    id,
  ]);
  return rows[0] ?? null;
}

// ---- Employee: file a request ----

exceptionsRouter.post('/', async (req, res) => {
  const me = auth(req);
  const body = parse(createSchema, req.body);
  validateShape(body, (await getSettings(pool, me.organizationId)).correctionWindowDays);

  let original = null;
  if (body.kind === 'missed_shift') {
    if (body.workSessionId) throw badRequest('A missed shift should not reference an existing shift');
  } else {
    if (!body.workSessionId) throw badRequest('Choose the shift you want to correct');
    original = await snapshotSession(pool, body.workSessionId);
    if (!original || original.user_id !== me.userId) throw notFound('Shift not found');
  }
  await assertNoOverlap(pool, me.userId, body, body.workSessionId ?? null);

  let id: string;
  try {
    const { rows } = await pool.query(
      `INSERT INTO punch_exceptions (organization_id, user_id, work_session_id, kind, requested_clock_in_at,
                                     requested_clock_out_at, requested_breaks, original, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        me.organizationId,
        me.userId,
        body.workSessionId ?? null,
        body.kind,
        body.clockInAt,
        body.clockOutAt,
        JSON.stringify(body.breaks),
        original && JSON.stringify({ clockInAt: original.clockInAt, clockOutAt: original.clockOutAt, breaks: original.breaks }),
        body.reason,
      ],
    );
    id = rows[0].id;
  } catch (err) {
    if (isUniqueViolation(err, 'punch_exceptions_one_pending_uq')) {
      throw conflict('already_pending', 'There is already a pending correction for this shift');
    }
    throw err;
  }
  exceptionSubmitted(id);
  res.status(201).json({ exception: await loadException(pool, me.organizationId, id) });
});

// ---- Lists ----

const listSchema = z.object({
  scope: z.enum(['mine', 'review']).default('mine'),
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'all']).default('all'),
});

exceptionsRouter.get('/', async (req, res) => {
  const me = auth(req);
  const q = parse(listSchema, req.query);
  const where = ['pe.organization_id = $1'];
  const values: unknown[] = [me.organizationId];

  if (q.scope === 'mine') {
    values.push(me.userId);
    where.push(`pe.user_id = $${values.length}`);
  } else {
    if (!atLeast(me.role, 'manager')) throw forbidden();
    values.push(me.userId);
    where.push(`pe.user_id <> $${values.length}`);
    if (!atLeast(me.role, 'admin')) where.push(`u.manager_id = $${values.length}`);
  }
  if (q.status !== 'all') {
    values.push(q.status);
    where.push(`pe.status = $${values.length}`);
  }
  const { rows } = await pool.query(
    `${EXCEPTION_SELECT} WHERE ${where.join(' AND ')} ORDER BY pe.created_at DESC LIMIT 200`,
    values,
  );
  res.json({ exceptions: rows });
});

/** Badge count for the nav. */
exceptionsRouter.get('/review-count', async (req, res) => {
  const me = auth(req);
  if (!atLeast(me.role, 'manager')) {
    res.json({ pending: 0 });
    return;
  }
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS pending FROM punch_exceptions pe JOIN users u ON u.id = pe.user_id
      WHERE pe.organization_id = $1 AND pe.status = 'pending' AND pe.user_id <> $2
        AND ($3::boolean OR u.manager_id = $2)`,
    [me.organizationId, me.userId, atLeast(me.role, 'admin')],
  );
  res.json(rows[0]);
});

exceptionsRouter.get('/:id', async (req, res) => {
  const me = auth(req);
  const ex = await loadException(pool, me.organizationId, parse(z.uuid(), req.params.id));
  if (!ex) throw notFound('Request not found');
  if (ex.user.id !== me.userId && !(await canReview(pool, me, ex.user.id))) throw notFound('Request not found');
  res.json({ exception: ex });
});

// ---- Employee: cancel ----

exceptionsRouter.post('/:id/cancel', async (req, res) => {
  const me = auth(req);
  const id = parse(z.uuid(), req.params.id);
  const { rowCount } = await pool.query(
    `UPDATE punch_exceptions SET status = 'cancelled'
      WHERE id = $1 AND organization_id = $2 AND user_id = $3 AND status = 'pending'`,
    [id, me.organizationId, me.userId],
  );
  if (!rowCount) throw conflict('not_pending', 'Only your own pending requests can be cancelled');
  res.json({ exception: await loadException(pool, me.organizationId, id) });
});

// ---- Reviewer: approve / reject ----

async function lockPendingForReview(db: Queryable, req: Parameters<typeof auth>[0], id: string) {
  const me = auth(req);
  const { rows } = await db.query(
    'SELECT * FROM punch_exceptions WHERE id = $1 AND organization_id = $2 FOR UPDATE',
    [id, me.organizationId],
  );
  const ex = rows[0];
  if (!ex) throw notFound('Request not found');
  if (!(await canReview(db, me, ex.user_id))) {
    throw ex.user_id === me.userId ? forbidden("You can't review your own request") : notFound('Request not found');
  }
  if (ex.status !== 'pending') throw conflict('not_pending', `This request was already ${ex.status}`);
  return ex;
}

exceptionsRouter.post('/:id/approve', async (req, res) => {
  const me = auth(req);
  const id = parse(z.uuid(), req.params.id);
  const { note } = parse(z.object({ note: z.string().trim().max(1000).optional() }), req.body ?? {});

  await tx(async (db) => {
    const ex = await lockPendingForReview(db, req, id);
    const requested: Requested = {
      clockInAt: ex.requested_clock_in_at,
      clockOutAt: ex.requested_clock_out_at,
      breaks: ex.requested_breaks.map((b: { startedAt: string; endedAt: string; kind: 'paid' | 'unpaid' }) => ({
        ...b,
        startedAt: new Date(b.startedAt),
        endedAt: new Date(b.endedAt),
      })),
    };

    let sessionId: string = ex.work_session_id;
    let before = null;
    if (ex.kind === 'missed_shift') {
      await assertNoOverlap(db, ex.user_id, requested, null);
      const { rows } = await db.query(
        `INSERT INTO work_sessions (organization_id, user_id, clock_in_at, clock_out_at, source)
         VALUES ($1, $2, $3, $4, 'correction') RETURNING id`,
        [ex.organization_id, ex.user_id, requested.clockInAt, requested.clockOutAt],
      );
      sessionId = rows[0].id;
    } else {
      if (!sessionId) throw conflict('session_missing', 'The original shift no longer exists');
      before = await snapshotSession(db, sessionId, true);
      await assertNoOverlap(db, ex.user_id, requested, sessionId);
      await db.query(
        `UPDATE work_sessions SET clock_in_at = $2, clock_out_at = $3, source = 'correction' WHERE id = $1`,
        [sessionId, requested.clockInAt, requested.clockOutAt],
      );
      await db.query('DELETE FROM breaks WHERE work_session_id = $1', [sessionId]);
    }
    for (const b of requested.breaks) {
      await db.query('INSERT INTO breaks (work_session_id, started_at, ended_at, kind) VALUES ($1, $2, $3, $4)', [
        sessionId,
        b.startedAt,
        b.endedAt,
        b.kind,
      ]);
    }
    await db.query(
      `UPDATE punch_exceptions SET status = 'approved', reviewer_id = $2, review_note = $3, reviewed_at = now(),
              work_session_id = $4 WHERE id = $1`,
      [id, me.userId, note ?? null, sessionId],
    );
    await audit(db, {
      organizationId: me.organizationId,
      actorId: me.userId,
      action: 'time.corrected',
      entity: 'work_session',
      entityId: sessionId,
      data: {
        exceptionId: id,
        employeeId: ex.user_id,
        before: before && { clockInAt: before.clockInAt, clockOutAt: before.clockOutAt, breaks: before.breaks },
        after: requested,
      },
    });
  });
  exceptionDecided(id);
  res.json({ exception: await loadException(pool, me.organizationId, id) });
});

exceptionsRouter.post('/:id/reject', async (req, res) => {
  const me = auth(req);
  const id = parse(z.uuid(), req.params.id);
  const { note } = parse(
    z.object({ note: z.string().trim().min(1, 'Tell the employee why').max(1000) }),
    req.body ?? {},
  );
  await tx(async (db) => {
    await lockPendingForReview(db, req, id);
    await db.query(
      `UPDATE punch_exceptions SET status = 'rejected', reviewer_id = $2, review_note = $3, reviewed_at = now()
        WHERE id = $1`,
      [id, me.userId, note],
    );
    await audit(db, {
      organizationId: me.organizationId,
      actorId: me.userId,
      action: 'exception.rejected',
      entity: 'punch_exception',
      entityId: id,
      data: { note },
    });
  });
  exceptionDecided(id);
  res.json({ exception: await loadException(pool, me.organizationId, id) });
});
