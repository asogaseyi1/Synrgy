import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { Router, type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { config } from '../config.ts';
import { isUniqueViolation, pool, tx, type Queryable } from '../db.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, errorHandler, forbidden, HttpError, notFound, parse } from '../lib/errors.ts';
import { DEFAULT_REPORT_CATEGORIES } from '../lib/settings.ts';
import { log } from '../lib/logger.ts';
import { auth } from '../middleware/auth.ts';

/*
 * Anonymous reporting.
 *
 * The public router is mounted BEFORE session loading, so these handlers never know who
 * (if anyone) is signed in. Nothing about the request (IP, user agent, cookies, exact time)
 * is stored or logged. The reporter proves ownership with a tracking code + secret key.
 */

// ---------- codes ----------

/** Crockford base32: no I, L, O, U, so codes are easy to read back and type. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LEN = 10; // ~50 bits; it's an identifier, not a secret
const KEY_LEN = 20; // ~100 bits; this is the secret

function randomCode(len: number) {
  // 256 is a multiple of 32, so `byte % 32` is unbiased.
  return [...randomBytes(len)].map((b) => ALPHABET[b % 32]).join('');
}

/** Accept lower case, spaces, dashes, and the usual look-alikes (O→0, I/L→1). */
export function normalizeCode(input: string) {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

const group = (s: string, size: number) => s.match(new RegExp(`.{1,${size}}`, 'g'))!.join('-');

const DUMMY_HASH = bcrypt.hashSync('not-a-real-report-key', config.bcryptRounds);

/** Calendar day in the organization's time zone (alias `o` = organizations). */
const ORG_TODAY = '(now() AT TIME ZONE o.timezone)::date';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => s || null)
    .nullable()
    .optional();

// ---------- shared queries ----------

/** Append a message. Caller must hold a row lock on the report so `seq` is race-free. */
async function addMessage(db: Queryable, reportId: string, kind: 'reporter' | 'reviewer', reviewerId: string | null, body: string) {
  await db.query(
    `INSERT INTO report_messages (report_id, seq, author_kind, reviewer_id, body, created_on)
     SELECT r.id, COALESCE((SELECT max(seq) FROM report_messages WHERE report_id = r.id), 0) + 1, $2, $3, $4, ${ORG_TODAY}
       FROM reports r JOIN organizations o ON o.id = r.organization_id
      WHERE r.id = $1`,
    [reportId, kind, reviewerId, body],
  );
  await db.query(
    `UPDATE reports r SET updated_on = ${ORG_TODAY} FROM organizations o WHERE o.id = r.organization_id AND r.id = $1`,
    [reportId],
  );
}

const REPORT_FIELDS = `
  r.tracking_code AS "trackingCode", r.category, r.description, r.incident_date::text AS "incidentDate",
  r.location, r.people_involved AS "peopleInvolved", r.status,
  r.created_on::text AS "createdOn", r.updated_on::text AS "updatedOn", r.closed_on::text AS "closedOn"`;

const isClosed = (status: string) => status === 'resolved' || status === 'dismissed';

// =====================================================================
// Public (anonymous) side
// =====================================================================

export const publicReportsRouter = Router();

publicReportsRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

async function findOrg(slug: string) {
  const { rows } = await pool.query('SELECT id, name, slug, timezone, settings FROM organizations WHERE slug = $1', [
    slug.toLowerCase(),
  ]);
  const org = rows[0];
  if (!org) throw notFound('No workspace with that ID');
  const categories: string[] = org.settings?.reportCategories ?? DEFAULT_REPORT_CATEGORIES;
  return { ...org, categories };
}

publicReportsRouter.get('/orgs/:slug', async (req, res) => {
  const org = await findOrg(String(req.params.slug));
  res.json({ organization: { name: org.name, slug: org.slug }, categories: org.categories });
});

const submitSchema = z.object({
  category: z.string().trim().min(1).max(80),
  description: z.string().trim().min(10, 'Please describe what happened (at least 10 characters)').max(10_000),
  incidentDate: z.iso.date().nullable().optional(),
  location: optionalText(200),
  peopleInvolved: optionalText(500),
});

publicReportsRouter.post('/orgs/:slug/reports', async (req, res) => {
  const org = await findOrg(String(req.params.slug));
  const body = parse(submitSchema, req.body);
  if (!org.categories.includes(body.category)) throw badRequest('Please choose one of the listed categories');
  if (body.incidentDate && body.incidentDate > new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)) {
    throw badRequest("The incident date can't be in the future");
  }

  const key = randomCode(KEY_LEN);
  const keyHash = await bcrypt.hash(key, config.bcryptRounds);
  let code = '';
  for (let attempt = 0; ; attempt++) {
    code = randomCode(CODE_LEN);
    try {
      await pool.query(
        `INSERT INTO reports (organization_id, tracking_code, access_key_hash, category, description,
                              incident_date, location, people_involved, created_on, updated_on)
         SELECT o.id, $2, $3, $4, $5, $6, $7, $8, ${ORG_TODAY}, ${ORG_TODAY} FROM organizations o WHERE o.id = $1`,
        [org.id, code, keyHash, body.category, body.description, body.incidentDate ?? null, body.location ?? null, body.peopleInvolved ?? null],
      );
      break;
    } catch (err) {
      if (attempt < 4 && isUniqueViolation(err, 'reports_tracking_code_key')) continue;
      throw err;
    }
  }
  // Deliberately no audit entry: the audit log is time-stamped and would date the report precisely.
  res.status(201).json({ trackingCode: group(code, 5), accessKey: group(key, 4), organization: org.name });
});

const credentialsSchema = z.object({
  workspace: z.string().trim().min(1).max(60),
  trackingCode: z.string().max(40),
  accessKey: z.string().max(60),
});
type Credentials = z.infer<typeof credentialsSchema>;

/** Verify code + key. Same error and similar timing whether the code or the key is wrong. */
async function authenticateReporter(db: Queryable, cred: Credentials, lock = false) {
  const { rows } = await db.query(
    `SELECT r.id, r.access_key_hash, r.status FROM reports r JOIN organizations o ON o.id = r.organization_id
      WHERE o.slug = $1 AND r.tracking_code = $2 ${lock ? 'FOR UPDATE OF r' : ''}`,
    [cred.workspace.toLowerCase(), normalizeCode(cred.trackingCode)],
  );
  const row = rows[0];
  const ok = await bcrypt.compare(normalizeCode(cred.accessKey), row?.access_key_hash ?? DUMMY_HASH);
  if (!row || !ok) throw notFound("We couldn't find a report with that tracking code and key");
  return row as { id: string; status: string };
}

/** What the reporter sees: their report and the thread, with investigators unnamed. */
async function reporterView(db: Queryable, reportId: string) {
  const { rows } = await db.query(`SELECT ${REPORT_FIELDS} FROM reports r WHERE r.id = $1`, [reportId]);
  const { rows: messages } = await db.query(
    `SELECT seq, author_kind AS "author", body, created_on::text AS "createdOn"
       FROM report_messages WHERE report_id = $1 ORDER BY seq`,
    [reportId],
  );
  const r = rows[0];
  return { ...r, trackingCode: group(r.trackingCode, 5), messages };
}

publicReportsRouter.post('/access', async (req, res) => {
  const cred = parse(credentialsSchema, req.body);
  const row = await authenticateReporter(pool, cred);
  res.json({ report: await reporterView(pool, row.id) });
});

publicReportsRouter.post('/messages', async (req, res) => {
  const body = parse(credentialsSchema.extend({ body: z.string().trim().min(1).max(5000) }), req.body);
  const report = await tx(async (db) => {
    const row = await authenticateReporter(db, body, true);
    if (isClosed(row.status)) throw badRequest('This report has been closed, so new messages are turned off');
    await addMessage(db, row.id, 'reporter', null, body.body);
    return reporterView(db, row.id);
  });
  res.json({ report });
});

/** Never log anything about the request on these routes, not even the error detail (pg detail can echo values). */
const scrubbedErrors: ErrorRequestHandler = (err, req, res, next) => {
  if (err instanceof HttpError || err?.type === 'entity.parse.failed') return errorHandler(err, req, res, next);
  log.error('report route error', { code: err?.code ?? err?.name ?? 'unknown' }); // no path, no detail
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong' } });
};
publicReportsRouter.use(scrubbedErrors);

// =====================================================================
// Reviewer side (signed in + can_review_reports)
// =====================================================================

export const reportsRouter = Router();

reportsRouter.use((req, res, next) => {
  if (!auth(req).canReviewReports) throw forbidden('Only designated report reviewers can see reports');
  res.set('Cache-Control', 'no-store');
  next();
});

/** New, or the reporter spoke last on an open report. */
const NEEDS_ATTENTION = `(r.status = 'new' OR (r.status = 'investigating' AND
  (SELECT m.author_kind FROM report_messages m WHERE m.report_id = r.id ORDER BY m.seq DESC LIMIT 1) = 'reporter'))`;

const STATUS_FILTERS = {
  open: "r.status IN ('new', 'investigating')",
  closed: "r.status IN ('resolved', 'dismissed')",
  all: 'TRUE',
} as const;

/** The inbox deliberately omits descriptions, so reading content always goes through the audited detail view. */
reportsRouter.get('/', async (req, res) => {
  const me = auth(req);
  const filter = parse(z.enum(['open', 'closed', 'all']).default('open'), req.query.status);
  const { rows } = await pool.query(
    `SELECT r.id, r.tracking_code AS "trackingCode", r.category, r.status,
            r.created_on::text AS "createdOn", r.updated_on::text AS "updatedOn", r.closed_on::text AS "closedOn",
            (SELECT count(*)::int FROM report_messages m WHERE m.report_id = r.id) AS "messageCount",
            ${NEEDS_ATTENTION} AS "needsAttention"
       FROM reports r
      WHERE r.organization_id = $1 AND ${STATUS_FILTERS[filter]}
      ORDER BY "needsAttention" DESC, r.updated_on DESC, r.created_on DESC
      LIMIT 200`,
    [me.organizationId],
  );
  res.json({ reports: rows.map((r) => ({ ...r, trackingCode: group(r.trackingCode, 5) })) });
});

reportsRouter.get('/counts', async (req, res) => {
  const me = auth(req);
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE ${NEEDS_ATTENTION})::int AS "needsAttention",
            count(*) FILTER (WHERE r.status IN ('new', 'investigating'))::int AS open
       FROM reports r WHERE r.organization_id = $1`,
    [me.organizationId],
  );
  res.json(rows[0]);
});

async function reviewerView(db: Queryable, organizationId: string, id: string) {
  const { rows } = await db.query(`SELECT r.id, ${REPORT_FIELDS} FROM reports r WHERE r.organization_id = $1 AND r.id = $2`, [
    organizationId,
    id,
  ]);
  const r = rows[0];
  if (!r) return null;
  const { rows: messages } = await db.query(
    `SELECT m.seq, m.author_kind AS "author", m.body, m.created_on::text AS "createdOn",
            CASE WHEN u.id IS NULL THEN NULL
                 ELSE json_build_object('id', u.id, 'firstName', u.first_name, 'lastName', u.last_name) END AS "reviewer"
       FROM report_messages m LEFT JOIN users u ON u.id = m.reviewer_id
      WHERE m.report_id = $1 ORDER BY m.seq`,
    [id],
  );
  const { rows: accessLog } = await db.query(
    `SELECT a.id, a.action, a.created_at AS "at", a.data,
            CASE WHEN u.id IS NULL THEN NULL
                 ELSE json_build_object('id', u.id, 'firstName', u.first_name, 'lastName', u.last_name) END AS "actor"
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.organization_id = $1 AND a.entity = 'report' AND a.entity_id = $2
      ORDER BY a.created_at DESC, a.id DESC LIMIT 100`,
    [organizationId, id],
  );
  return { ...r, trackingCode: group(r.trackingCode, 5), messages, accessLog };
}

async function lockReport(db: Queryable, organizationId: string, id: string) {
  const { rows } = await db.query('SELECT id, status FROM reports WHERE organization_id = $1 AND id = $2 FOR UPDATE', [
    organizationId,
    id,
  ]);
  if (!rows[0]) throw notFound('Report not found');
  return rows[0] as { id: string; status: string };
}

/** Opening a report is always audited, so reviewers can see who has read it. */
reportsRouter.get('/:id', async (req, res) => {
  const me = auth(req);
  const id = parse(z.uuid(), req.params.id);
  const exists = await pool.query('SELECT 1 FROM reports WHERE organization_id = $1 AND id = $2', [me.organizationId, id]);
  if (!exists.rowCount) throw notFound('Report not found');
  await audit(pool, { organizationId: me.organizationId, actorId: me.userId, action: 'report.viewed', entity: 'report', entityId: id });
  res.json({ report: await reviewerView(pool, me.organizationId, id) });
});

reportsRouter.patch('/:id', async (req, res) => {
  const me = auth(req);
  const id = parse(z.uuid(), req.params.id);
  const { status } = parse(z.object({ status: z.enum(['new', 'investigating', 'resolved', 'dismissed']) }), req.body);
  const report = await tx(async (db) => {
    const cur = await lockReport(db, me.organizationId, id);
    if (cur.status !== status) {
      await db.query(
        `UPDATE reports r SET status = $2::report_status, updated_on = ${ORG_TODAY},
                closed_on = CASE WHEN $2::report_status IN ('resolved', 'dismissed') THEN ${ORG_TODAY} ELSE NULL END
           FROM organizations o WHERE o.id = r.organization_id AND r.id = $1`,
        [id, status],
      );
      await audit(db, {
        organizationId: me.organizationId,
        actorId: me.userId,
        action: 'report.status_changed',
        entity: 'report',
        entityId: id,
        data: { from: cur.status, to: status },
      });
    }
    return reviewerView(db, me.organizationId, id);
  });
  res.json({ report });
});

reportsRouter.post('/:id/messages', async (req, res) => {
  const me = auth(req);
  const id = parse(z.uuid(), req.params.id);
  const { body } = parse(z.object({ body: z.string().trim().min(1).max(5000) }), req.body);
  const report = await tx(async (db) => {
    const cur = await lockReport(db, me.organizationId, id);
    await addMessage(db, id, 'reviewer', me.userId, body);
    // Replying to a new report means someone has picked it up.
    if (cur.status === 'new') await db.query("UPDATE reports SET status = 'investigating' WHERE id = $1", [id]);
    await audit(db, {
      organizationId: me.organizationId,
      actorId: me.userId,
      action: 'report.replied',
      entity: 'report',
      entityId: id,
      data: cur.status === 'new' ? { from: 'new', to: 'investigating' } : {},
    });
    return reviewerView(db, me.organizationId, id);
  });
  res.json({ report });
});
