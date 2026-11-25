import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { config } from '../config.ts';

/*
 * Structured logging: one JSON object per line in production (LOG_FORMAT=json), readable lines in dev.
 *
 * Privacy rules, enforced here rather than left to each call site:
 *   - anonymous reporting traffic (/api/public/reports/*, and the /r/* pages) is never logged at all;
 *   - secrets in URLs (invite and password-reset tokens) are redacted;
 *   - query strings, bodies, cookies, IPs and user agents are not logged.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS[(config.logLevel as Level) in LEVELS ? (config.logLevel as Level) : 'info'];
/** For tests. */
export function setLogLevel(level: Level) {
  threshold = LEVELS[level];
}

/** Sink, replaceable in tests. */
export let logSink: (line: string, level: Level) => void = (line, level) =>
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
export function setLogSink(sink: typeof logSink) {
  logSink = sink;
}

function write(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (LEVELS[level] < threshold) return;
  if (config.logFormat === 'json') {
    logSink(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }), level);
  } else {
    const extra = Object.entries(fields)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    logSink(`${level.toUpperCase().padEnd(5)} ${msg}${extra ? ' ' + extra : ''}`, level);
  }
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => write('debug', msg, f),
  info: (msg: string, f?: Record<string, unknown>) => write('info', msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => write('warn', msg, f),
  error: (msg: string, f?: Record<string, unknown>) => write('error', msg, f),
};

/** Paths that must never appear in logs (anonymous reporting). */
export const isUnloggedPath = (path: string) => path.startsWith('/api/public/reports') || path === '/r' || path.startsWith('/r/');

/** Replace secret path segments (tokens) with placeholders. */
export function redactPath(path: string): string {
  return path
    .replace(/^(\/api\/invitations\/)[^/]+/, '$1:token')
    .replace(/^(\/api\/auth\/password-reset\/)[^/]+/, '$1:token')
    .replace(/^(\/invite\/)[^/]+/, '$1:token')
    .replace(/^(\/reset\/)[^/]+/, '$1:token');
}

/** Summarise an error without leaking values (pg's `detail` can echo row data). */
export function errorFields(err: unknown): Record<string, unknown> {
  const e = err as { name?: string; message?: string; code?: string; stack?: string };
  return {
    error: e?.name ?? 'Error',
    code: e?.code,
    message: e?.code ? undefined : e?.message, // pg errors: code only
    stack: config.isProd ? undefined : e?.stack?.split('\n').slice(1, 4).map((s) => s.trim()),
  };
}

/** Access log + request id. Mounted first so every response is covered. */
export const requestLogger: RequestHandler = (req, res, next) => {
  // Capture now: routers strip their mount prefix from req.path while handling.
  const path = req.path;
  if (isUnloggedPath(path)) return next();
  const incoming = req.get('x-request-id');
  const id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.locals.requestId = id;
  res.set('X-Request-Id', id);
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    if (path === '/api/health' || path === '/api/health/ready') return; // probe noise
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const level: Level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    write(level, 'request', {
      reqId: id,
      method: req.method,
      path: redactPath(path),
      status: res.statusCode,
      ms: Math.round(ms * 10) / 10,
      user: req.auth?.userId,
      org: req.auth?.organizationId,
    });
  });
  next();
};
