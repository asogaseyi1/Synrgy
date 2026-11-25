import { Router } from 'express';
import { z } from 'zod';
import { pool, isUniqueViolation } from '../db.ts';
import { audit } from '../lib/audit.ts';
import { conflict, notFound, parse } from '../lib/errors.ts';
import { getOrg } from '../lib/settings.ts';
import { isValidTimezone } from '../lib/users.ts';
import { auth, requireRole } from '../middleware/auth.ts';

export const organizationRouter = Router();

organizationRouter.get('/', async (req, res) => {
  res.json({ organization: await getOrg(pool, auth(req).organizationId) });
});

const profileSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    timezone: z.string().refine(isValidTimezone, 'Unknown time zone'),
  })
  .partial();

organizationRouter.patch('/', requireRole('admin'), async (req, res) => {
  const me = auth(req);
  const patch = parse(profileSchema, req.body);
  await pool.query('UPDATE organizations SET name = COALESCE($2, name), timezone = COALESCE($3, timezone) WHERE id = $1', [
    me.organizationId,
    patch.name ?? null,
    patch.timezone ?? null,
  ]);
  await audit(pool, { organizationId: me.organizationId, actorId: me.userId, action: 'organization.updated', entity: 'organization', entityId: me.organizationId, data: patch });
  res.json({ organization: await getOrg(pool, me.organizationId) });
});

const hoursOrNull = (max: number) => z.number().min(0.5).max(max).nullable();

const settingsSchema = z
  .object({
    requireSwapApproval: z.boolean(),
    maxWeeklyHours: z.number().int().min(1).max(168).nullable(),
    weekStartsOn: z.union([z.literal(0), z.literal(1)]),
    staleOpenHours: z.number().int().min(4).max(48),
    correctionWindowDays: z.number().int().min(1).max(366),
    roundingMinutes: z.union([z.literal(0), z.literal(5), z.literal(6), z.literal(10), z.literal(15), z.literal(30)]),
    autoBreakAfterHours: hoursOrNull(24),
    autoBreakMinutes: z.number().int().min(5).max(120),
    dailyOvertimeHours: hoursOrNull(24),
    weeklyOvertimeHours: hoursOrNull(168),
    reportCategories: z
      .array(z.string().trim().min(1).max(80))
      .min(1)
      .max(20)
      .transform((list) => [...new Set(list)]),
  })
  .partial();

organizationRouter.patch('/settings', requireRole('admin'), async (req, res) => {
  const me = auth(req);
  const patch = parse(settingsSchema, req.body);
  await pool.query('UPDATE organizations SET settings = settings || $2::jsonb WHERE id = $1', [
    me.organizationId,
    JSON.stringify(patch),
  ]);
  await audit(pool, {
    organizationId: me.organizationId,
    actorId: me.userId,
    action: 'organization.settings_updated',
    entity: 'organization',
    entityId: me.organizationId,
    data: patch,
  });
  res.json({ organization: await getOrg(pool, me.organizationId) });
});

// ---------- Departments & locations ----------

const UNIT_SELECT = `
  SELECT ou.id, ou.kind, ou.name,
         (SELECT count(*)::int FROM users u
           WHERE u.status = 'active' AND (u.department_id = ou.id OR u.location_id = ou.id)) AS "memberCount"
    FROM org_units ou`;

organizationRouter.get('/units', async (req, res) => {
  const { rows } = await pool.query(`${UNIT_SELECT} WHERE ou.organization_id = $1 ORDER BY ou.kind, lower(ou.name)`, [
    auth(req).organizationId,
  ]);
  res.json({ units: rows });
});

const unitSchema = z.object({ kind: z.enum(['department', 'location']), name: z.string().trim().min(1).max(100) });

organizationRouter.post('/units', requireRole('admin'), async (req, res) => {
  const me = auth(req);
  const body = parse(unitSchema, req.body);
  try {
    const { rows } = await pool.query('INSERT INTO org_units (organization_id, kind, name) VALUES ($1, $2, $3) RETURNING id', [
      me.organizationId,
      body.kind,
      body.name,
    ]);
    await audit(pool, { organizationId: me.organizationId, actorId: me.userId, action: 'unit.created', entity: 'org_unit', entityId: rows[0].id, data: body });
    const unit = await pool.query(`${UNIT_SELECT} WHERE ou.id = $1`, [rows[0].id]);
    res.status(201).json({ unit: unit.rows[0] });
  } catch (err) {
    if (isUniqueViolation(err, 'org_units_name_uq')) throw conflict('duplicate', `There's already a ${body.kind} with that name`);
    throw err;
  }
});

organizationRouter.patch('/units/:id', requireRole('admin'), async (req, res) => {
  const me = auth(req);
  const id = parse(z.uuid(), req.params.id);
  const { name } = parse(unitSchema.pick({ name: true }), req.body);
  try {
    const { rowCount } = await pool.query('UPDATE org_units SET name = $3 WHERE id = $1 AND organization_id = $2', [id, me.organizationId, name]);
    if (!rowCount) throw notFound('Not found');
  } catch (err) {
    if (isUniqueViolation(err, 'org_units_name_uq')) throw conflict('duplicate', 'That name is already used');
    throw err;
  }
  await audit(pool, { organizationId: me.organizationId, actorId: me.userId, action: 'unit.renamed', entity: 'org_unit', entityId: id, data: { name } });
  const unit = await pool.query(`${UNIT_SELECT} WHERE ou.id = $1`, [id]);
  res.json({ unit: unit.rows[0] });
});

/** Members keep working; they're just unassigned. Announcements targeted at it are removed (FK cascade). */
organizationRouter.delete('/units/:id', requireRole('admin'), async (req, res) => {
  const me = auth(req);
  const id = parse(z.uuid(), req.params.id);
  const { rows } = await pool.query('DELETE FROM org_units WHERE id = $1 AND organization_id = $2 RETURNING kind, name', [id, me.organizationId]);
  if (!rows[0]) throw notFound('Not found');
  await audit(pool, { organizationId: me.organizationId, actorId: me.userId, action: 'unit.deleted', entity: 'org_unit', entityId: id, data: rows[0] });
  res.status(204).end();
});
