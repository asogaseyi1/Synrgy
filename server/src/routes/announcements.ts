import { Router } from 'express';
import { z } from 'zod';
import { pool, tx, type Queryable } from '../db.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, forbidden, notFound, parse } from '../lib/errors.ts';
import { atLeast, auth, requireRole, type AuthContext } from '../middleware/auth.ts';

export const announcementsRouter = Router();

const isoDate = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
const roleEnum = z.enum(['owner', 'admin', 'manager', 'employee']);

/** Does user `u` fall inside announcement `a`'s audience? Every filter that is set must match. */
const IN_AUDIENCE = `
  (cardinality(a.audience_roles) = 0 OR u.role = ANY(a.audience_roles))
  AND (a.audience_team_of IS NULL OR u.id = a.audience_team_of OR u.manager_id = a.audience_team_of)
  AND (a.audience_department_id IS NULL OR u.department_id = a.audience_department_id)
  AND (a.audience_location_id IS NULL OR u.location_id = a.audience_location_id)`;

const IS_LIVE = 'a.publish_at <= now() AND (a.expires_at IS NULL OR a.expires_at > now())';

const COLUMNS = `
  a.id, a.title, a.body, a.pinned, a.requires_ack AS "requiresAck",
  a.publish_at AS "publishAt", a.expires_at AS "expiresAt", a.created_at AS "createdAt",
  a.content_edited_at AS "editedAt",
  a.audience_roles::text[] AS "audienceRoles",
  CASE WHEN tm.id IS NULL THEN NULL
       ELSE json_build_object('id', tm.id, 'firstName', tm.first_name, 'lastName', tm.last_name) END AS "audienceTeam",
  CASE WHEN dep.id IS NULL THEN NULL ELSE json_build_object('id', dep.id, 'name', dep.name) END AS "audienceDepartment",
  CASE WHEN loc.id IS NULL THEN NULL ELSE json_build_object('id', loc.id, 'name', loc.name) END AS "audienceLocation",
  CASE WHEN au.id IS NULL THEN NULL
       ELSE json_build_object('id', au.id, 'firstName', au.first_name, 'lastName', au.last_name) END AS "author"`;

const JOINS = `
  LEFT JOIN users au ON au.id = a.author_id
  LEFT JOIN users tm ON tm.id = a.audience_team_of
  LEFT JOIN org_units dep ON dep.id = a.audience_department_id
  LEFT JOIN org_units loc ON loc.id = a.audience_location_id`;

/** Admins manage everything; managers manage what they wrote. */
function manageScope(me: AuthContext, values: unknown[]) {
  if (atLeast(me.role, 'admin')) return 'TRUE';
  values.push(me.userId);
  return `a.author_id = $${values.length}`;
}

// ---------- Reader side ----------

/** My feed: live announcements I'm in the audience for (plus my own). `?archived=1` shows expired ones. */
announcementsRouter.get('/', async (req, res) => {
  const me = auth(req);
  const archived = req.query.archived === '1';
  const when = archived ? 'a.expires_at <= now()' : IS_LIVE;
  const { rows } = await pool.query(
    `SELECT ${COLUMNS}, r.read_at AS "readAt", r.acknowledged_at AS "acknowledgedAt",
            COALESCE(a.author_id = $2, false) AS "isAuthor"
       FROM announcements a
       JOIN users u ON u.id = $2
       ${JOINS}
       LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = $2
      WHERE a.organization_id = $1 AND ${when} AND (a.author_id = $2 OR (${IN_AUDIENCE}))
      ORDER BY ${archived ? '' : 'a.pinned DESC,'} a.publish_at DESC
      LIMIT 100`,
    [me.organizationId, me.userId],
  );
  res.json({ announcements: rows });
});

announcementsRouter.get('/unread-count', async (req, res) => {
  const me = auth(req);
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE r.read_at IS NULL)::int AS unread,
            count(*) FILTER (WHERE a.requires_ack AND r.acknowledged_at IS NULL)::int AS "needsAck"
       FROM announcements a
       JOIN users u ON u.id = $2
       LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = $2
      WHERE a.organization_id = $1 AND ${IS_LIVE} AND a.author_id IS DISTINCT FROM $2 AND ${IN_AUDIENCE}`,
    [me.organizationId, me.userId],
  );
  res.json(rows[0]);
});

/** Mark several announcements read (the feed does this for what it shows). */
announcementsRouter.post('/read', async (req, res) => {
  const me = auth(req);
  const { ids } = parse(z.object({ ids: z.array(z.uuid()).min(1).max(100) }), req.body);
  const { rowCount } = await pool.query(
    `INSERT INTO announcement_reads (announcement_id, user_id)
     SELECT a.id, u.id FROM announcements a JOIN users u ON u.id = $2
      WHERE a.organization_id = $1 AND a.id = ANY($3::uuid[]) AND a.publish_at <= now()
        AND a.author_id IS DISTINCT FROM $2 AND ${IN_AUDIENCE}
     ON CONFLICT DO NOTHING`,
    [me.organizationId, me.userId, ids],
  );
  res.json({ marked: rowCount });
});

announcementsRouter.post('/:id/acknowledge', async (req, res) => {
  const me = auth(req);
  const id = parse(z.uuid(), req.params.id);
  const { rows } = await pool.query(
    `SELECT a.requires_ack FROM announcements a JOIN users u ON u.id = $3
      WHERE a.organization_id = $1 AND a.id = $2 AND ${IS_LIVE}
        AND a.author_id IS DISTINCT FROM $3 AND ${IN_AUDIENCE}`,
    [me.organizationId, id, me.userId],
  );
  if (!rows[0]) throw notFound('Announcement not found');
  if (!rows[0].requires_ack) throw badRequest("This announcement doesn't need acknowledgement");
  const { rows: ack } = await pool.query(
    `INSERT INTO announcement_reads (announcement_id, user_id, acknowledged_at) VALUES ($1, $2, now())
     ON CONFLICT (announcement_id, user_id)
       DO UPDATE SET acknowledged_at = COALESCE(announcement_reads.acknowledged_at, now())
     RETURNING read_at AS "readAt", acknowledged_at AS "acknowledgedAt"`,
    [id, me.userId],
  );
  res.json(ack[0]);
});

// ---------- Author / admin side ----------

const STATS = `
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS recipients, count(r.read_at)::int AS read, count(r.acknowledged_at)::int AS acknowledged
      FROM users u
      LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = u.id
     WHERE u.organization_id = a.organization_id AND u.status = 'active'
       AND u.id IS DISTINCT FROM a.author_id AND ${IN_AUDIENCE}
  ) st ON TRUE`;

const MANAGE_SELECT = `
  SELECT ${COLUMNS},
         CASE WHEN a.publish_at > now() THEN 'scheduled'
              WHEN a.expires_at IS NOT NULL AND a.expires_at <= now() THEN 'expired'
              ELSE 'live' END AS "state",
         json_build_object('recipients', st.recipients, 'read', st.read, 'acknowledged', st.acknowledged) AS "stats"
    FROM announcements a ${JOINS} ${STATS}`;

announcementsRouter.get('/manage', requireRole('manager'), async (req, res) => {
  const me = auth(req);
  const values: unknown[] = [me.organizationId];
  const scope = manageScope(me, values);
  const { rows } = await pool.query(
    `${MANAGE_SELECT} WHERE a.organization_id = $1 AND ${scope} ORDER BY a.publish_at DESC LIMIT 200`,
    values,
  );
  res.json({ announcements: rows });
});

async function loadManaged(db: Queryable, me: AuthContext, id: string) {
  const values: unknown[] = [me.organizationId, id];
  const scope = manageScope(me, values);
  const { rows } = await db.query(`${MANAGE_SELECT} WHERE a.organization_id = $1 AND a.id = $2 AND ${scope}`, values);
  return rows[0] ?? null;
}

/** Lock a row for editing, enforcing who may manage it. */
async function lockManaged(db: Queryable, me: AuthContext, id: string) {
  const { rows } = await db.query('SELECT * FROM announcements WHERE id = $1 AND organization_id = $2 FOR UPDATE', [
    id,
    me.organizationId,
  ]);
  const row = rows[0];
  if (!row) throw notFound('Announcement not found');
  if (!atLeast(me.role, 'admin') && row.author_id !== me.userId) throw forbidden("You can't edit this announcement");
  return row;
}

const fields = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20_000),
  audienceRoles: z.array(roleEnum).max(4),
  audienceTeamOf: z.uuid().nullable(),
  audienceDepartmentId: z.uuid().nullable(),
  audienceLocationId: z.uuid().nullable(),
  pinned: z.boolean(),
  requiresAck: z.boolean(),
  publishAt: isoDate.nullable(),
  expiresAt: isoDate.nullable(),
});

/**
 * Managers can only address their own team; admins can address anyone.
 * Returns the effective team id.
 */
async function resolveTeam(db: Queryable, me: AuthContext, teamOf: string | null | undefined): Promise<string | null> {
  if (!atLeast(me.role, 'admin')) {
    if (teamOf && teamOf !== me.userId) throw forbidden('Managers can only post to their own team');
    return me.userId;
  }
  if (!teamOf) return null;
  const { rowCount } = await db.query(
    "SELECT 1 FROM users WHERE id = $1 AND organization_id = $2 AND status = 'active' AND role <> 'employee'",
    [teamOf, me.organizationId],
  );
  if (!rowCount) throw badRequest('Team must belong to an active manager');
  return teamOf;
}

async function checkUnit(db: Queryable, me: AuthContext, id: string | null | undefined, kind: 'department' | 'location') {
  if (!id) return null;
  const { rowCount } = await db.query('SELECT 1 FROM org_units WHERE id = $1 AND organization_id = $2 AND kind = $3', [id, me.organizationId, kind]);
  if (!rowCount) throw badRequest(`Unknown ${kind}`);
  return id;
}

function checkWindow(publishAt: Date, expiresAt: Date | null) {
  if (expiresAt && expiresAt <= publishAt) throw badRequest('Expiry must be after the publish time');
}

announcementsRouter.post('/', requireRole('manager'), async (req, res) => {
  const me = auth(req);
  const body = parse(fields.partial({ audienceRoles: true, audienceTeamOf: true, audienceDepartmentId: true, audienceLocationId: true, pinned: true, requiresAck: true, publishAt: true, expiresAt: true }), req.body);
  const publishAt = body.publishAt ?? new Date();
  const expiresAt = body.expiresAt ?? null;
  checkWindow(publishAt, expiresAt);
  if (expiresAt && expiresAt <= new Date()) throw badRequest('Expiry must be in the future');
  const roles = [...new Set(body.audienceRoles ?? [])];

  const id = await tx(async (db) => {
    const team = await resolveTeam(db, me, body.audienceTeamOf);
    const dept = await checkUnit(db, me, body.audienceDepartmentId, 'department');
    const loc = await checkUnit(db, me, body.audienceLocationId, 'location');
    const { rows } = await db.query(
      `INSERT INTO announcements (organization_id, author_id, title, body, audience_roles, audience_team_of,
                                  audience_department_id, audience_location_id, pinned, requires_ack, publish_at, expires_at)
       VALUES ($1, $2, $3, $4, $5::user_role[], $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [me.organizationId, me.userId, body.title, body.body, roles, team, dept, loc, body.pinned ?? false, body.requiresAck ?? false, publishAt, expiresAt],
    );
    await audit(db, {
      organizationId: me.organizationId,
      actorId: me.userId,
      action: 'announcement.created',
      entity: 'announcement',
      entityId: rows[0].id,
      data: { title: body.title, roles, team, requiresAck: body.requiresAck ?? false },
    });
    return rows[0].id as string;
  });
  res.status(201).json({ announcement: await loadManaged(pool, me, id) });
});

announcementsRouter.patch('/:id', requireRole('manager'), async (req, res) => {
  const me = auth(req);
  const id = parse(z.uuid(), req.params.id);
  const patch = parse(fields.partial(), req.body);

  await tx(async (db) => {
    const cur = await lockManaged(db, me, id);
    const next = {
      title: patch.title ?? cur.title,
      body: patch.body ?? cur.body,
      roles: patch.audienceRoles ? [...new Set(patch.audienceRoles)] : null,
      team: patch.audienceTeamOf !== undefined ? await resolveTeam(db, me, patch.audienceTeamOf) : cur.audience_team_of,
      dept: patch.audienceDepartmentId !== undefined ? await checkUnit(db, me, patch.audienceDepartmentId, 'department') : cur.audience_department_id,
      loc: patch.audienceLocationId !== undefined ? await checkUnit(db, me, patch.audienceLocationId, 'location') : cur.audience_location_id,
      pinned: patch.pinned ?? cur.pinned,
      requiresAck: patch.requiresAck ?? cur.requires_ack,
      publishAt: patch.publishAt !== undefined ? (patch.publishAt ?? new Date()) : cur.publish_at,
      expiresAt: patch.expiresAt !== undefined ? patch.expiresAt : cur.expires_at,
    };
    checkWindow(next.publishAt, next.expiresAt);

    // A substantive change to something already out means earlier acknowledgements no longer apply.
    const contentChanged = next.title !== cur.title || next.body !== cur.body;
    const wasPublished = cur.publish_at <= new Date();
    const resetAcks = contentChanged && wasPublished;

    await db.query(
      `UPDATE announcements
          SET title = $2, body = $3, audience_roles = COALESCE($4::user_role[], audience_roles), audience_team_of = $5,
              pinned = $6, requires_ack = $7, publish_at = $8, expires_at = $9, updated_at = now(),
              content_edited_at = CASE WHEN $10 THEN now() ELSE content_edited_at END,
              audience_department_id = $11, audience_location_id = $12
        WHERE id = $1`,
      [id, next.title, next.body, next.roles, next.team, next.pinned, next.requiresAck, next.publishAt, next.expiresAt, resetAcks, next.dept, next.loc],
    );
    if (resetAcks) await db.query('UPDATE announcement_reads SET acknowledged_at = NULL WHERE announcement_id = $1', [id]);
    await audit(db, {
      organizationId: me.organizationId,
      actorId: me.userId,
      action: 'announcement.updated',
      entity: 'announcement',
      entityId: id,
      data: { fields: Object.keys(patch), acknowledgementsReset: resetAcks && cur.requires_ack },
    });
  });
  res.json({ announcement: await loadManaged(pool, me, id) });
});

announcementsRouter.delete('/:id', requireRole('manager'), async (req, res) => {
  const me = auth(req);
  const id = parse(z.uuid(), req.params.id);
  await tx(async (db) => {
    const cur = await lockManaged(db, me, id);
    await db.query('DELETE FROM announcements WHERE id = $1', [id]);
    await audit(db, {
      organizationId: me.organizationId,
      actorId: me.userId,
      action: 'announcement.deleted',
      entity: 'announcement',
      entityId: id,
      data: { title: cur.title, publishAt: cur.publish_at },
    });
  });
  res.status(204).end();
});

/** Who has (and hasn't) read / acknowledged. Unread first. */
announcementsRouter.get('/:id/receipts', requireRole('manager'), async (req, res) => {
  const me = auth(req);
  const id = parse(z.uuid(), req.params.id);
  if (!(await loadManaged(pool, me, id))) throw notFound('Announcement not found');
  const { rows } = await pool.query(
    `SELECT u.id, u.first_name AS "firstName", u.last_name AS "lastName", u.role,
            r.read_at AS "readAt", r.acknowledged_at AS "acknowledgedAt"
       FROM announcements a
       JOIN users u ON u.organization_id = a.organization_id AND u.status = 'active'
                   AND u.id IS DISTINCT FROM a.author_id AND ${IN_AUDIENCE}
       LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = u.id
      WHERE a.id = $1
      ORDER BY r.acknowledged_at IS NOT NULL, r.read_at IS NOT NULL, u.last_name, u.first_name`,
    [id],
  );
  res.json({ receipts: rows });
});
