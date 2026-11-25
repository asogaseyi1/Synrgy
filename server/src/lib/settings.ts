import type { Queryable } from '../db.ts';

/**
 * Organization-level policy. Stored in organizations.settings (jsonb, shallow-merged on update);
 * unset keys fall back to defaults. Keys are kept flat so a partial update never wipes siblings.
 */
export interface OrgSettings {
  // --- Scheduling ---
  /** Swaps need a manager's approval after the coworker accepts. */
  requireSwapApproval: boolean;
  /** Cap on scheduled hours per person per week (org time zone). null = no cap. */
  maxWeeklyHours: number | null;
  /** 0 = Sunday, 1 = Monday. Used for schedules, weekly caps and weekly overtime. */
  weekStartsOn: 0 | 1;

  // --- Time clock ---
  /** An open session older than this is flagged as a probable forgotten clock-out. */
  staleOpenHours: number;
  /** How far back employees can request time corrections. */
  correctionWindowDays: number;

  // --- Payroll rules (applied to calculations and exports; raw punches are never changed) ---
  /** Round clock-in/out to the nearest N minutes. 0 = exact. */
  roundingMinutes: 0 | 5 | 6 | 10 | 15 | 30;
  /** Auto-deduct an unpaid break on shifts at least this long. null = off. */
  autoBreakAfterHours: number | null;
  /** Length of the auto-deducted break; only the shortfall vs. unpaid breaks actually taken is deducted. */
  autoBreakMinutes: number;
  /** Hours per day after which time counts as overtime. null = no daily overtime. */
  dailyOvertimeHours: number | null;
  /** Hours per week after which time counts as overtime. null = no weekly overtime. */
  weeklyOvertimeHours: number | null;

  // --- Reporting ---
  /** Choices offered on the anonymous reporting form. */
  reportCategories: string[];
}

export const DEFAULT_REPORT_CATEGORIES = [
  'Harassment or discrimination',
  'Health and safety',
  'Fraud, theft or bribery',
  'Conflict of interest',
  'Retaliation',
  'Policy or code of conduct violation',
  'Other',
];

export const DEFAULT_SETTINGS: OrgSettings = {
  requireSwapApproval: true,
  maxWeeklyHours: null,
  weekStartsOn: 1,
  staleOpenHours: 16,
  correctionWindowDays: 31,
  roundingMinutes: 0,
  autoBreakAfterHours: null,
  autoBreakMinutes: 30,
  dailyOvertimeHours: null,
  weeklyOvertimeHours: 40,
  reportCategories: DEFAULT_REPORT_CATEGORIES,
};

export async function getOrg(db: Queryable, organizationId: string) {
  const { rows } = await db.query('SELECT id, name, slug, timezone, settings FROM organizations WHERE id = $1', [
    organizationId,
  ]);
  const org = rows[0];
  return { ...org, settings: { ...DEFAULT_SETTINGS, ...org.settings } as OrgSettings };
}

export async function getSettings(db: Queryable, organizationId: string): Promise<OrgSettings> {
  return (await getOrg(db, organizationId)).settings;
}

/**
 * SQL for the start of the week containing `ts`, in time zone `tz` (both SQL expressions),
 * honouring the org's week start. Postgres' date_trunc('week') is Monday-based.
 */
export function weekStartSql(ts: string, tz: string, weekStartsOn: 0 | 1) {
  return weekStartsOn === 1
    ? `(date_trunc('week', ${ts} AT TIME ZONE ${tz}) AT TIME ZONE ${tz})`
    : `((date_trunc('week', (${ts} AT TIME ZONE ${tz}) + interval '1 day') - interval '1 day') AT TIME ZONE ${tz})`;
}
