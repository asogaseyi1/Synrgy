import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db.ts';
import { audit } from '../lib/audit.ts';
import { parse } from '../lib/errors.ts';
import { getOrg } from '../lib/settings.ts';
import { auth, requireRole } from '../middleware/auth.ts';

export const organizationRouter = Router();

organizationRouter.get('/', async (req, res) => {
  res.json({ organization: await getOrg(pool, auth(req).organizationId) });
});

const settingsSchema = z
  .object({
    requireSwapApproval: z.boolean(),
    maxWeeklyHours: z.number().int().min(1).max(168).nullable(),
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
