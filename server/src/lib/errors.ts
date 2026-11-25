import type { ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { isUniqueViolation } from '../db.ts';
import { errorFields, log, redactPath } from './logger.ts';

export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Not signed in') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do that') =>
  new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);

/** Parse `data` with a zod schema, throwing a 400 with field errors on failure. */
export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest('Invalid request', z.flattenError(result.error).fieldErrors);
  }
  return result.data;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if ((err as { code?: string })?.code === '23P01') {
    res.status(409).json({ error: { code: 'schedule_conflict', message: 'That person already has a shift at that time' } });
    return;
  }
  if (isUniqueViolation(err)) {
    res.status(409).json({ error: { code: 'conflict', message: 'That record already exists' } });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'bad_request', message: 'Malformed JSON' } });
    return;
  }
  // Client errors raised by middleware (body too large, missing static file, ...).
  const status = Number(err?.status ?? err?.statusCode);
  if (status >= 400 && status < 500) {
    res.status(status).json({ error: { code: err?.type ?? 'client_error', message: err?.expose ? err.message : 'Request rejected' } });
    return;
  }
  log.error('unhandled error', { reqId: res.locals.requestId, method: req.method, path: redactPath(req.originalUrl.split('?')[0]), ...errorFields(err) });
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong' } });
};
