import type { Queryable } from '../db.ts';
import { atLeast, type AuthContext } from '../middleware/auth.ts';

/** Is `me` the direct manager of `userId` (same org)? */
export async function isManagerOf(db: Queryable, me: AuthContext, userId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    'SELECT 1 FROM users WHERE id = $1 AND organization_id = $2 AND manager_id = $3',
    [userId, me.organizationId, me.userId],
  );
  return !!rowCount;
}

/** Can `me` see this person's time records? Self, admins+, or their direct manager. */
export async function canViewTime(db: Queryable, me: AuthContext, userId: string): Promise<boolean> {
  if (userId === me.userId || atLeast(me.role, 'admin')) return true;
  return me.role === 'manager' && isManagerOf(db, me, userId);
}

/** Can `me` approve this person's requests? Admins+ or their direct manager — never yourself. */
export async function canReview(db: Queryable, me: AuthContext, userId: string): Promise<boolean> {
  if (userId === me.userId) return false;
  if (atLeast(me.role, 'admin')) return true;
  return me.role === 'manager' && isManagerOf(db, me, userId);
}
