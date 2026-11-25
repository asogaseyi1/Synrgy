import { Router } from 'express';
import { z } from 'zod';
import { pool, tx, isUniqueViolation, type Queryable } from '../db.ts';
import { isManagerOf } from '../lib/access.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, conflict, forbidden, notFound, parse } from '../lib/errors.ts';
import { swapDecided, swapNeedsApproval, swapRequested } from '../lib/notify.ts';
import { getOrg, weekStartSql, type OrgSettings } from '../lib/settings.ts';
import { atLeast, auth, type AuthContext } from '../middleware/auth.ts';

export const swapsRouter = Router();

const ACTIVE = `('pending_peer', 'pending_manager')`;

// ---------------------------------------------------------------------------
// Queries

const person = (alias: string) =>
  `CASE WHEN ${alias}.id IS NULL THEN NULL
        ELSE json_build_object('id', ${alias}.id, 'firstName', ${alias}.first_name, 'lastName', ${alias}.last_name) END`;
const shiftJson = (alias: string) =>
  `CASE WHEN ${alias}.id IS NULL THEN NULL
        ELSE json_build_object('id', ${alias}.id, 'startsAt', ${alias}.starts_at, 'endsAt', ${alias}.ends_at,
                               'position', ${alias}.position, 'location', ${alias}.location) END`;

const SWAP_SELECT = `
  SELECT sw.id, sw.type, sw.status, sw.message, sw.review_note AS "reviewNote", sw.created_at AS "createdAt",
         sw.reviewed_at AS "reviewedAt",
         ${shiftJson('s')} AS shift, ${shiftJson('ts')} AS "targetShift",
         ${person('rq')} AS requester, ${person('tu')} AS "targetUser",
         ${person('ac')} AS "acceptedBy", ${person('rv')} AS reviewer
    FROM shift_swaps sw
    JOIN scheduled_shifts s ON s.id = sw.shift_id
    LEFT JOIN scheduled_shifts ts ON ts.id = sw.target_shift_id
    JOIN users rq ON rq.id = sw.requester_id
    LEFT JOIN users tu ON tu.id = sw.target_user_id
    LEFT JOIN users ac ON ac.id = sw.accepted_by
    LEFT JOIN users rv ON rv.id = sw.reviewer_id`;

async function loadSwap(db: Queryable, organizationId: string, id: string) {
  const { rows } = await db.query(`${SWAP_SELECT} WHERE sw.organization_id = $1 AND sw.id = $2`, [organizationId, id]);
  return rows[0] ?? null;
}

/** SQL filter for swaps `me` may approve: pending_manager, not involving me, admin or manager of either party. */
function reviewableClause(me: AuthContext, p: number) {
  const notMine = `sw.requester_id <> $${p} AND COALESCE(sw.accepted_by, '00000000-0000-0000-0000-000000000000') <> $${p}`;
  if (atLeast(me.role, 'admin')) return notMine;
  return `${notMine} AND (rq.manager_id = $${p} OR ac.manager_id = $${p})`;
}

async function canReviewSwap(db: Queryable, me: AuthContext, swap: { requester_id: string; accepted_by: string | null }) {
  if (swap.requester_id === me.userId || swap.accepted_by === me.userId) return false;
  if (atLeast(me.role, 'admin')) return true;
  if (me.role !== 'manager') return false;
  return (
    (await isManagerOf(db, me, swap.requester_id)) || (!!swap.accepted_by && (await isManagerOf(db, me, swap.accepted_by)))
  );
}

// ---------------------------------------------------------------------------
// Conflict checks

interface ShiftRow {
  id: string;
  user_id: string | null;
  starts_at: Date;
  ends_at: Date;
  published_at: Date | null;
}

/**
 * Would giving `incoming` to `userId` (while they give up `outgoingId`, for swaps) cause an overlap
 * or push them over the weekly hours cap?
 */
async function checkAssignment(
  db: Queryable,
  org: { timezone: string; settings: OrgSettings },
  userId: string,
  incoming: ShiftRow,
  outgoingId: string | null,
  who: string,
) {
  const exclude = [incoming.id, outgoingId].filter(Boolean);
  const overlap = await db.query(
    `SELECT 1 FROM scheduled_shifts
      WHERE user_id = $1 AND id <> ALL($2::uuid[]) AND tstzrange(starts_at, ends_at) && tstzrange($3, $4)`,
    [userId, exclude, incoming.starts_at, incoming.ends_at],
  );
  if (overlap.rowCount) throw conflict('schedule_conflict', `${who} already has a shift at that time`);

  const max = org.settings.maxWeeklyHours;
  if (max) {
    const { rows } = await db.query(
      `WITH wk AS (SELECT ${weekStartSql('$3::timestamptz', '$4', org.settings.weekStartsOn)} AS start)
       SELECT COALESCE(SUM(EXTRACT(EPOCH FROM s.ends_at - s.starts_at)), 0)::float AS seconds
         FROM scheduled_shifts s, wk
        WHERE s.user_id = $1 AND s.id <> ALL($2::uuid[])
          AND s.starts_at >= wk.start AND s.starts_at < wk.start + interval '7 days'`,
      [userId, exclude, incoming.starts_at, org.timezone],
    );
    const total = rows[0].seconds + (incoming.ends_at.getTime() - incoming.starts_at.getTime()) / 1000;
    if (total > max * 3600) {
      throw conflict('over_hours', `${who} would be scheduled for ${(total / 3600).toFixed(1)}h that week (limit ${max}h)`);
    }
  }
}

async function lockShift(db: Queryable, id: string): Promise<ShiftRow> {
  const { rows } = await db.query(
    'SELECT id, user_id, starts_at, ends_at, published_at FROM scheduled_shifts WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (!rows[0]) throw conflict('shift_missing', 'That shift no longer exists');
  return rows[0];
}

const isFuturePublished = (s: ShiftRow) => !!s.published_at && s.starts_at.getTime() > Date.now();

/** Validate everything still holds and return the locked shifts. Used at accept and at approval. */
async function verifySwap(db: Queryable, org: Awaited<ReturnType<typeof getOrg>>, sw: Record<string, any>, receiverId: string) {
  const shift = await lockShift(db, sw.shift_id);
  if (shift.user_id !== sw.requester_id) throw conflict('stale', 'That shift has been reassigned');
  if (!isFuturePublished(shift)) throw conflict('stale', 'That shift has already started');
  let target: ShiftRow | null = null;
  if (sw.type === 'swap') {
    target = await lockShift(db, sw.target_shift_id);
    if (target.user_id !== sw.target_user_id) throw conflict('stale', 'The other shift has been reassigned');
    if (!isFuturePublished(target)) throw conflict('stale', 'The other shift has already started');
  }
  const receiver = await db.query("SELECT first_name FROM users WHERE id = $1 AND status = 'active'", [receiverId]);
  if (!receiver.rowCount) throw conflict('stale', 'That person is no longer active');
  await checkAssignment(db, org, receiverId, shift, target?.id ?? null, receiver.rows[0].first_name);
  if (target) {
    const rq = await db.query('SELECT first_name FROM users WHERE id = $1', [sw.requester_id]);
    await checkAssignment(db, org, sw.requester_id, target, shift.id, rq.rows[0].first_name);
  }
  return { shift, target };
}

/** Reassign the shift(s) and mark the swap approved. Caller holds the transaction. */
async function applySwap(
  db: Queryable,
  me: AuthContext,
  sw: Record<string, any>,
  receiverId: string,
  review: { reviewerId: string | null; note: string | null },
) {
  // Clear first so the no-overlap constraint never sees a half-finished swap.
  await db.query('UPDATE scheduled_shifts SET user_id = NULL, updated_at = now() WHERE id = $1', [sw.shift_id]);
  if (sw.type === 'swap') {
    await db.query('UPDATE scheduled_shifts SET user_id = $2, updated_at = now() WHERE id = $1', [sw.target_shift_id, sw.requester_id]);
  }
  await db.query('UPDATE scheduled_shifts SET user_id = $2, updated_at = now() WHERE id = $1', [sw.shift_id, receiverId]);
  await db.query(
    `UPDATE shift_swaps SET status = 'approved', reviewer_id = $2, review_note = $3, reviewed_at = now() WHERE id = $1`,
    [sw.id, review.reviewerId, review.note],
  );
  // Any other pending request involving these shifts is now meaningless.
  await db.query(
    `UPDATE shift_swaps SET status = 'cancelled', review_note = 'Shift was swapped in another request'
      WHERE id <> $1 AND status IN ${ACTIVE}
        AND (shift_id = ANY($2::uuid[]) OR target_shift_id = ANY($2::uuid[]))`,
    [sw.id, [sw.shift_id, sw.target_shift_id].filter(Boolean)],
  );
  await audit(db, {
    organizationId: me.organizationId,
    actorId: me.userId,
    action: 'swap.approved',
    entity: 'shift_swap',
    entityId: sw.id,
    data: {
      type: sw.type,
      shiftId: sw.shift_id,
      targetShiftId: sw.target_shift_id,
      from: sw.requester_id,
      to: receiverId,
      autoApproved: review.reviewerId === null,
    },
  });
}

async function lockSwap(db: Queryable, me: AuthContext, id: string) {
  const { rows } = await db.query('SELECT * FROM shift_swaps WHERE id = $1 AND organization_id = $2 FOR UPDATE', [
    id,
    me.organizationId,
  ]);
  if (!rows[0]) throw notFound('Swap request not found');
  return rows[0];
}

// ---------------------------------------------------------------------------
// Routes

const createSchema = z.object({
  shiftId: z.uuid(),
  type: z.enum(['swap', 'cover', 'open']),
  targetUserId: z.uuid().optional(),
  targetShiftId: z.uuid().optional(),
  message: z.string().trim().max(500).optional(),
});

swapsRouter.post('/', async (req, res) => {
  const me = auth(req);
  const body = parse(createSchema, req.body);
  const org = await getOrg(pool, me.organizationId);

  const id = await tx(async (db) => {
    const shift = await lockShift(db, body.shiftId).catch(() => null);
    if (!shift || shift.user_id !== me.userId) throw notFound('Shift not found');
    if (!isFuturePublished(shift)) throw badRequest('You can only swap upcoming, published shifts');

    let targetUserId: string | null = null;
    let targetShiftId: string | null = null;
    if (body.type === 'swap') {
      if (!body.targetShiftId) throw badRequest('Pick the shift you want in return');
      const target = await lockShift(db, body.targetShiftId).catch(() => null);
      if (!target || !target.user_id || !isFuturePublished(target)) throw badRequest('Pick an upcoming, assigned shift');
      if (target.user_id === me.userId) throw badRequest("You can't swap with yourself");
      const busy = await db.query(
        `SELECT 1 FROM shift_swaps WHERE status IN ${ACTIVE} AND (shift_id = $1 OR target_shift_id = $1)`,
        [target.id],
      );
      if (busy.rowCount) throw conflict('already_pending', 'That shift is already part of another swap request');
      targetUserId = target.user_id;
      targetShiftId = target.id;
    } else if (body.type === 'cover') {
      if (!body.targetUserId) throw badRequest('Pick who should cover your shift');
      if (body.targetUserId === me.userId) throw badRequest("You can't ask yourself");
      targetUserId = body.targetUserId;
    }
    if (targetUserId) {
      const ok = await db.query(
        "SELECT 1 FROM users WHERE id = $1 AND organization_id = $2 AND status = 'active'",
        [targetUserId, me.organizationId],
      );
      if (!ok.rowCount) throw badRequest('That person is not an active member');
    }

    // Early feedback: would the coworker even be able to take it?
    if (body.type !== 'open') {
      await verifySwap(db, org, { ...body, shift_id: shift.id, requester_id: me.userId, target_user_id: targetUserId, target_shift_id: targetShiftId }, targetUserId!);
    }

    try {
      const { rows } = await db.query(
        `INSERT INTO shift_swaps (organization_id, type, shift_id, requester_id, target_user_id, target_shift_id, message)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [me.organizationId, body.type, shift.id, me.userId, targetUserId, targetShiftId, body.message || null],
      );
      return rows[0].id as string;
    } catch (err) {
      if (isUniqueViolation(err, 'shift_swaps_one_active_uq')) {
        throw conflict('already_pending', 'This shift already has an active swap request');
      }
      throw err;
    }
  });
  swapRequested(id);
  res.status(201).json({ swap: await loadSwap(pool, me.organizationId, id) });
});

/** Everything the Swaps page needs in one call. */
swapsRouter.get('/', async (req, res) => {
  const me = auth(req);
  const q = (where: string, extra: unknown[] = []) =>
    pool
      .query(`${SWAP_SELECT} WHERE sw.organization_id = $1 AND ${where} ORDER BY s.starts_at LIMIT 100`, [
        me.organizationId,
        me.userId,
        ...extra,
      ])
      .then((r) => r.rows);

  const [mine, incoming, available, review] = await Promise.all([
    q(`sw.requester_id = $2 AND (sw.status IN ${ACTIVE} OR sw.created_at > now() - interval '30 days')`),
    q(`sw.target_user_id = $2 AND sw.status = 'pending_peer'`),
    q(`sw.type = 'open' AND sw.status = 'pending_peer' AND sw.requester_id <> $2 AND s.starts_at > now()`),
    atLeast(me.role, 'manager') ? q(`sw.status = 'pending_manager' AND ${reviewableClause(me, 2)}`) : Promise.resolve([]),
  ]);
  res.json({ mine, incoming, available, review });
});

/** Nav badge: things waiting on me. */
swapsRouter.get('/counts', async (req, res) => {
  const me = auth(req);
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE sw.target_user_id = $2 AND sw.status = 'pending_peer')::int AS incoming,
       COUNT(*) FILTER (WHERE $3::boolean AND sw.status = 'pending_manager' AND ${reviewableClause(me, 2)})::int AS review
     FROM shift_swaps sw
     JOIN users rq ON rq.id = sw.requester_id
     LEFT JOIN users ac ON ac.id = sw.accepted_by
     WHERE sw.organization_id = $1 AND sw.status IN ${ACTIVE}`,
    [me.organizationId, me.userId, atLeast(me.role, 'manager')],
  );
  res.json(rows[0]);
});

swapsRouter.post('/:id/accept', async (req, res) => {
  const me = auth(req);
  const id = parse(z.uuid(), req.params.id);
  const org = await getOrg(pool, me.organizationId);
  await tx(async (db) => {
    const sw = await lockSwap(db, me, id);
    if (sw.status !== 'pending_peer') throw conflict('not_pending', 'This request is no longer open');
    if (sw.type === 'open') {
      if (sw.requester_id === me.userId) throw badRequest("You can't pick up your own shift");
    } else if (sw.target_user_id !== me.userId) {
      throw notFound('Swap request not found');
    }
    await verifySwap(db, org, sw, me.userId);
    await db.query(
      `UPDATE shift_swaps SET accepted_by = $2, responded_at = now(), status = 'pending_manager' WHERE id = $1`,
      [id, me.userId],
    );
    if (!org.settings.requireSwapApproval) await applySwap(db, me, sw, me.userId, { reviewerId: null, note: null });
  });
  if (org.settings.requireSwapApproval) swapNeedsApproval(id);
  else swapDecided(id);
  res.json({ swap: await loadSwap(pool, me.organizationId, id) });
});

swapsRouter.post('/:id/decline', async (req, res) => {
  const me = auth(req);
  const id = parse(z.uuid(), req.params.id);
  const { rowCount } = await pool.query(
    `UPDATE shift_swaps SET status = 'declined', responded_at = now()
      WHERE id = $1 AND organization_id = $2 AND target_user_id = $3 AND status = 'pending_peer'`,
    [id, me.organizationId, me.userId],
  );
  if (!rowCount) throw conflict('not_pending', 'This request is no longer open');
  swapDecided(id);
  res.json({ swap: await loadSwap(pool, me.organizationId, id) });
});

swapsRouter.post('/:id/cancel', async (req, res) => {
  const me = auth(req);
  const id = parse(z.uuid(), req.params.id);
  const { rowCount } = await pool.query(
    `UPDATE shift_swaps SET status = 'cancelled'
      WHERE id = $1 AND organization_id = $2 AND requester_id = $3 AND status IN ${ACTIVE}`,
    [id, me.organizationId, me.userId],
  );
  if (!rowCount) throw conflict('not_pending', 'Only your own open requests can be cancelled');
  res.json({ swap: await loadSwap(pool, me.organizationId, id) });
});

const noteSchema = z.object({ note: z.string().trim().max(1000).optional() });

swapsRouter.post('/:id/approve', async (req, res) => {
  const me = auth(req);
  const id = parse(z.uuid(), req.params.id);
  const { note } = parse(noteSchema, req.body ?? {});
  const org = await getOrg(pool, me.organizationId);
  await tx(async (db) => {
    const sw = await lockSwap(db, me, id);
    if (!(await canReviewSwap(db, me, sw))) throw forbidden("You can't approve this swap");
    if (sw.status !== 'pending_manager') throw conflict('not_pending', 'This request is not waiting for approval');
    await verifySwap(db, org, sw, sw.accepted_by);
    await applySwap(db, me, sw, sw.accepted_by, { reviewerId: me.userId, note: note || null });
  });
  swapDecided(id);
  res.json({ swap: await loadSwap(pool, me.organizationId, id) });
});

swapsRouter.post('/:id/reject', async (req, res) => {
  const me = auth(req);
  const id = parse(z.uuid(), req.params.id);
  const { note } = parse(z.object({ note: z.string().trim().min(1, 'Add a short reason').max(1000) }), req.body ?? {});
  await tx(async (db) => {
    const sw = await lockSwap(db, me, id);
    if (!(await canReviewSwap(db, me, sw))) throw forbidden("You can't review this swap");
    if (sw.status !== 'pending_manager') throw conflict('not_pending', 'This request is not waiting for approval');
    await db.query(
      `UPDATE shift_swaps SET status = 'rejected', reviewer_id = $2, review_note = $3, reviewed_at = now() WHERE id = $1`,
      [id, me.userId, note],
    );
    await audit(db, { organizationId: me.organizationId, actorId: me.userId, action: 'swap.rejected', entity: 'shift_swap', entityId: id, data: { note } });
  });
  swapDecided(id);
  res.json({ swap: await loadSwap(pool, me.organizationId, id) });
});
