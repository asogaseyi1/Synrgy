import { createHash, randomBytes } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { config } from '../config.ts';
import { HttpError } from '../lib/errors.ts';

// ---------------------------------------------------------------------------
// Rate limiting: fixed window, in memory. Good for a single API process; swap the store for
// Redis/Postgres when running several instances.

interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

let enabled = config.rateLimits;
/** For tests. */
export function setRateLimitsEnabled(on: boolean) {
  enabled = on;
  buckets.clear();
}

// Sweep expired buckets so memory stays bounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, 60_000).unref();

/** Process-local salt: limiter keys never contain a raw IP, and can't be reversed after a restart. */
const SALT = randomBytes(16);
const hashKey = (s: string) => createHash('sha256').update(SALT).update(s).digest('base64url').slice(0, 22);

export const clientIp = (req: Request) => req.ip ?? req.socket.remoteAddress ?? 'unknown';

/**
 * Allow `max` requests per `windowMs` for each key. `key` defaults to the client IP; return
 * extra parts (e.g. the email being tried) to limit per account as well.
 */
export function rateLimit(name: string, max: number, windowMs: number, key: (req: Request) => string = clientIp): RequestHandler {
  return (req, res, next) => {
    if (!enabled) return next();
    const k = `${name}:${hashKey(key(req))}`;
    const now = Date.now();
    let b = buckets.get(k);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(k, b);
    }
    b.count++;
    if (b.count > max) {
      const retry = Math.ceil((b.resetAt - now) / 1000);
      res.set('Retry-After', String(retry));
      throw new HttpError(429, 'rate_limited', `Too many attempts. Try again in ${Math.ceil(retry / 60)} minute(s).`);
    }
    next();
  };
}

/** Lower-cased field from a JSON body, for per-account limits. */
export const bodyField = (field: string) => (req: Request) => String(req.body?.[field] ?? '').toLowerCase();

// ---------------------------------------------------------------------------
// CSRF. Session cookies are SameSite=Lax (blocks most cross-site sends). On top of that, a
// state-changing request must not look like a cross-site form post:
//   - form-encodable content types are rejected (the API only speaks JSON), and
//   - if the browser sends an Origin, it must be an allowed one.
// Cross-site JSON with credentials needs CORS, which the API never grants.

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const FORM_TYPES = /^(application\/x-www-form-urlencoded|multipart\/form-data|text\/plain)/i;

function originAllowed(origin: string, req: Request): boolean {
  if (origin === config.clientOrigin || config.allowedOrigins.includes(origin)) return true;
  try {
    const u = new URL(origin);
    if (u.host === req.get('host')) return true; // same origin (e.g. API serving the built client)
    if (!config.isProd && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true; // dev servers on any port
  } catch {
    return false;
  }
  return false;
}

export const csrfProtection: RequestHandler = (req, _res, next) => {
  if (!UNSAFE.has(req.method)) return next();
  const type = req.get('content-type');
  if (type && FORM_TYPES.test(type)) throw new HttpError(415, 'unsupported_media_type', 'Requests must be JSON');
  const origin = req.get('origin');
  if (origin && origin !== 'null' && !originAllowed(origin, req)) {
    throw new HttpError(403, 'bad_origin', 'Cross-site request blocked');
  }
  if (origin === 'null') throw new HttpError(403, 'bad_origin', 'Cross-site request blocked');
  next();
};
