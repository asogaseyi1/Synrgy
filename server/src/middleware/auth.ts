import type { Request, RequestHandler, Response } from 'express';
import { config } from '../config.ts';
import { pool, type Queryable } from '../db.ts';
import { forbidden, unauthorized } from '../lib/errors.ts';
import { hashToken, newToken } from '../lib/tokens.ts';

export type Role = 'owner' | 'admin' | 'manager' | 'employee';

export interface AuthContext {
  userId: string;
  organizationId: string;
  role: Role;
  canReviewReports: boolean;
}

export const SESSION_COOKIE = 'synrgy_sid';

const ROLE_RANK: Record<Role, number> = { employee: 0, manager: 1, admin: 2, owner: 3 };
export const atLeast = (role: Role, min: Role) => ROLE_RANK[role] >= ROLE_RANK[min];

export async function startSession(db: Queryable, res: Response, userId: string): Promise<void> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + config.sessionTtlDays * 86_400_000);
  await db.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
    hashToken(token),
    userId,
    expiresAt,
  ]);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.https,
    expires: expiresAt,
    path: '/',
  });
}

export async function endSession(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Attach req.auth when a valid session cookie is present. Never rejects. */
export const loadSession: RequestHandler = async (req, _res, next) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return next();
  const { rows } = await pool.query(
    `SELECT u.id, u.organization_id, u.role, u.can_review_reports
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.status = 'active'`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (row) {
    req.auth = {
      userId: row.id,
      organizationId: row.organization_id,
      role: row.role,
      canReviewReports: row.can_review_reports,
    };
  }
  next();
};

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.auth) throw unauthorized();
  next();
};

export const requireRole =
  (min: Role): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth) throw unauthorized();
    if (!atLeast(req.auth.role, min)) throw forbidden();
    next();
  };

/** Narrow req.auth for handlers mounted behind requireAuth. */
export function auth(req: Request): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
