import type { Queryable } from '../db.ts';

/** Organization-level policy. Stored in organizations.settings (jsonb); unset keys fall back to defaults. */
export interface OrgSettings {
  /** Swaps need a manager's approval after the coworker accepts. */
  requireSwapApproval: boolean;
  /** Cap on scheduled hours per person per week (Mon–Sun, org time zone). null = no cap. */
  maxWeeklyHours: number | null;
}

export const DEFAULT_SETTINGS: OrgSettings = { requireSwapApproval: true, maxWeeklyHours: null };

export async function getOrg(db: Queryable, organizationId: string) {
  const { rows } = await db.query('SELECT id, name, slug, timezone, settings FROM organizations WHERE id = $1', [
    organizationId,
  ]);
  const org = rows[0];
  return { ...org, settings: { ...DEFAULT_SETTINGS, ...org.settings } as OrgSettings };
}
