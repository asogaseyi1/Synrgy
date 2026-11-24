import type { Queryable } from '../db.ts';

export const USER_COLUMNS = `u.id, u.email, u.first_name AS "firstName", u.last_name AS "lastName", u.role,
  u.can_review_reports AS "canReviewReports", u.manager_id AS "managerId", u.status, u.created_at AS "createdAt"`;

export async function getUser(db: Queryable, organizationId: string, userId: string) {
  const { rows } = await db.query(
    `SELECT ${USER_COLUMNS} FROM users u WHERE u.organization_id = $1 AND u.id = $2`,
    [organizationId, userId],
  );
  return rows[0] ?? null;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
