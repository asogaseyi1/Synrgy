import { Router } from 'express';
import { z } from 'zod';
import { pool, tx, isUniqueViolation, type Queryable } from '../db.ts';
import { badRequest, conflict, forbidden, parse } from '../lib/errors.ts';
import { atLeast, auth, requireRole, type AuthContext } from '../middleware/auth.ts';

export const timeRouter = Router();

/** Current clock state: off, working, or on break. */
async function getStatus(db: Queryable, userId: string) {
  const { rows } = await db.query(
    `SELECT ws.id, ws.clock_in_at AS "clockInAt",
            b.id AS "breakId", b.started_at AS "breakStartedAt", b.kind AS "breakKind"
       FROM work_sessions ws
       LEFT JOIN breaks b ON b.work_session_id = ws.id AND b.ended_at IS NULL
      WHERE ws.user_id = $1 AND ws.clock_out_at IS NULL`,
    [userId],
  );
  const row = rows[0];
  if (!row) return { state: 'off' as const, session: null, break: null };
  return {
    state: row.breakId ? ('on_break' as const) : ('working' as const),
    session: { id: row.id, clockInAt: row.clockInAt },
    break: row.breakId ? { id: row.breakId, startedAt: row.breakStartedAt, kind: row.breakKind } : null,
  };
}

timeRouter.get('/status', async (req, res) => {
  res.json(await getStatus(pool, auth(req).userId));
});

timeRouter.post('/clock-in', async (req, res) => {
  const me = auth(req);
  const notes = parse(z.object({ notes: z.string().max(500).optional() }), req.body ?? {}).notes;
  try {
    await pool.query(
      'INSERT INTO work_sessions (organization_id, user_id, clock_in_at, notes) VALUES ($1, $2, now(), $3)',
      [me.organizationId, me.userId, notes ?? null],
    );
  } catch (err) {
    if (isUniqueViolation(err, 'work_sessions_one_open_uq')) throw conflict('already_clocked_in', 'You are already clocked in');
    throw err;
  }
  res.status(201).json(await getStatus(pool, me.userId));
});

timeRouter.post('/clock-out', async (req, res) => {
  const me = auth(req);
  const status = await tx(async (db) => {
    const open = await db.query(
      'SELECT id FROM work_sessions WHERE user_id = $1 AND clock_out_at IS NULL FOR UPDATE',
      [me.userId],
    );
    if (!open.rows[0]) throw conflict('not_clocked_in', 'You are not clocked in');
    const sessionId = open.rows[0].id;
    // Clocking out also ends any break still running.
    await db.query('UPDATE breaks SET ended_at = now() WHERE work_session_id = $1 AND ended_at IS NULL', [sessionId]);
    await db.query('UPDATE work_sessions SET clock_out_at = now() WHERE id = $1', [sessionId]);
    return getStatus(db, me.userId);
  });
  res.json(status);
});

timeRouter.post('/break/start', async (req, res) => {
  const me = auth(req);
  const { kind } = parse(z.object({ kind: z.enum(['paid', 'unpaid']).default('unpaid') }), req.body ?? {});
  const status = await tx(async (db) => {
    const open = await db.query(
      'SELECT id FROM work_sessions WHERE user_id = $1 AND clock_out_at IS NULL FOR UPDATE',
      [me.userId],
    );
    if (!open.rows[0]) throw conflict('not_clocked_in', 'Clock in before starting a break');
    try {
      await db.query('INSERT INTO breaks (work_session_id, started_at, kind) VALUES ($1, now(), $2)', [
        open.rows[0].id,
        kind,
      ]);
    } catch (err) {
      if (isUniqueViolation(err, 'breaks_one_open_uq')) throw conflict('already_on_break', 'You are already on a break');
      throw err;
    }
    return getStatus(db, me.userId);
  });
  res.status(201).json(status);
});

timeRouter.post('/break/end', async (req, res) => {
  const me = auth(req);
  const { rowCount } = await pool.query(
    `UPDATE breaks b SET ended_at = now() FROM work_sessions ws
      WHERE b.work_session_id = ws.id AND ws.user_id = $1 AND ws.clock_out_at IS NULL AND b.ended_at IS NULL`,
    [me.userId],
  );
  if (!rowCount) throw conflict('not_on_break', 'You are not on a break');
  res.json(await getStatus(pool, me.userId));
});

// ---- Timesheets ----

const MAX_RANGE_DAYS = 93;

const rangeSchema = z
  .object({
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    userId: z.uuid().optional(),
  })
  .transform(({ from, to, userId }) => {
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 14 * 86_400_000);
    return { from: fromDate, to: toDate, userId };
  })
  .refine((r) => r.from < r.to, 'from must be before to')
  .refine((r) => r.to.getTime() - r.from.getTime() <= MAX_RANGE_DAYS * 86_400_000, `Range can be at most ${MAX_RANGE_DAYS} days`);

/** Self, admins/owners for anyone in the org, managers for their direct reports. */
async function assertCanView(me: AuthContext, userId: string) {
  if (userId === me.userId || atLeast(me.role, 'admin')) return;
  if (me.role === 'manager') {
    const { rowCount } = await pool.query(
      'SELECT 1 FROM users WHERE id = $1 AND organization_id = $2 AND manager_id = $3',
      [userId, me.organizationId, me.userId],
    );
    if (rowCount) return;
  }
  throw forbidden("You can't view this person's time");
}

const SESSION_TOTALS = `
  EXTRACT(EPOCH FROM COALESCE(ws.clock_out_at, now()) - ws.clock_in_at)::int AS "totalSeconds",
  COALESCE(SUM(EXTRACT(EPOCH FROM COALESCE(b.ended_at, now()) - b.started_at))
           FILTER (WHERE b.kind = 'unpaid'), 0)::int AS "unpaidBreakSeconds",
  COALESCE(SUM(EXTRACT(EPOCH FROM COALESCE(b.ended_at, now()) - b.started_at))
           FILTER (WHERE b.kind = 'paid'), 0)::int AS "paidBreakSeconds"`;

timeRouter.get('/sessions', async (req, res) => {
  const me = auth(req);
  const range = parse(rangeSchema, req.query);
  const userId = range.userId ?? me.userId;
  await assertCanView(me, userId);

  const { rows } = await pool.query(
    `SELECT ws.id, ws.clock_in_at AS "clockInAt", ws.clock_out_at AS "clockOutAt", ws.source, ws.notes,
            COALESCE(json_agg(json_build_object(
              'id', b.id, 'startedAt', b.started_at, 'endedAt', b.ended_at, 'kind', b.kind)
              ORDER BY b.started_at) FILTER (WHERE b.id IS NOT NULL), '[]') AS breaks,
            ${SESSION_TOTALS}
       FROM work_sessions ws LEFT JOIN breaks b ON b.work_session_id = ws.id
      WHERE ws.organization_id = $1 AND ws.user_id = $2 AND ws.clock_in_at >= $3 AND ws.clock_in_at < $4
      GROUP BY ws.id ORDER BY ws.clock_in_at DESC`,
    [me.organizationId, userId, range.from, range.to],
  );
  const sessions = rows.map((r) => ({ ...r, workedSeconds: r.totalSeconds - r.unpaidBreakSeconds }));
  const totals = sessions.reduce(
    (t, s) => ({
      workedSeconds: t.workedSeconds + s.workedSeconds,
      breakSeconds: t.breakSeconds + s.unpaidBreakSeconds + s.paidBreakSeconds,
    }),
    { workedSeconds: 0, breakSeconds: 0 },
  );
  res.json({ userId, from: range.from, to: range.to, sessions, totals });
});

/** Per-person summary for a manager's reports, or the whole org for admins. */
timeRouter.get('/team', requireRole('manager'), async (req, res) => {
  const me = auth(req);
  const range = parse(rangeSchema, req.query);
  if (range.userId) throw badRequest('Use /sessions?userId= for one person');
  const scopeToReports = !atLeast(me.role, 'admin');

  const { rows } = await pool.query(
    `WITH per_session AS (
       SELECT ws.id, ws.user_id, ws.clock_out_at, ${SESSION_TOTALS}
         FROM work_sessions ws LEFT JOIN breaks b ON b.work_session_id = ws.id
        WHERE ws.organization_id = $1 AND ws.clock_in_at >= $2 AND ws.clock_in_at < $3
        GROUP BY ws.id)
     SELECT u.id AS "userId", u.first_name AS "firstName", u.last_name AS "lastName", u.role,
            COUNT(ps.id)::int AS "sessionCount",
            COALESCE(SUM(ps."totalSeconds" - ps."unpaidBreakSeconds"), 0)::int AS "workedSeconds",
            EXISTS (SELECT 1 FROM work_sessions o WHERE o.user_id = u.id AND o.clock_out_at IS NULL) AS "clockedIn"
       FROM users u LEFT JOIN per_session ps ON ps.user_id = u.id
      WHERE u.organization_id = $1 AND u.status = 'active' AND ($4::uuid IS NULL OR u.manager_id = $4)
      GROUP BY u.id ORDER BY u.last_name, u.first_name`,
    [me.organizationId, range.from, range.to, scopeToReports ? me.userId : null],
  );
  res.json({ from: range.from, to: range.to, members: rows });
});
