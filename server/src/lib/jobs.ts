import { pool } from '../db.ts';
import { appLink, background, sendMail } from './mailer.ts';

/**
 * Daily confidential-report digest for reviewers.
 *
 * Reviewers are NOT emailed when a report arrives: a timestamped email would date the report to
 * the minute, undoing the day-only storage. Instead, once a day after DIGEST_HOUR (org local time),
 * reviewers get a count. The email never contains report content.
 */
export const DIGEST_HOUR = 8;

export async function runReportDigests(now = new Date()): Promise<number> {
  const { rows: orgs } = await pool.query(
    `SELECT o.id, o.name, ($1::timestamptz AT TIME ZONE o.timezone)::date::text AS today,
            EXTRACT(HOUR FROM $1::timestamptz AT TIME ZONE o.timezone)::int AS hour,
            (SELECT count(*)::int FROM reports r
              WHERE r.organization_id = o.id AND (r.status = 'new' OR (r.status = 'investigating' AND
                (SELECT m.author_kind FROM report_messages m WHERE m.report_id = r.id ORDER BY m.seq DESC LIMIT 1) = 'reporter'))
            ) AS pending
       FROM organizations o`,
    [now],
  );
  let sent = 0;
  for (const org of orgs) {
    if (org.hour < DIGEST_HOUR || org.pending === 0) continue;
    // Claim today's run; a second process (or a second tick) sees the row and skips.
    const claim = await pool.query(
      `INSERT INTO job_runs (organization_id, job, run_on) VALUES ($1, 'report_digest', $2) ON CONFLICT DO NOTHING`,
      [org.id, org.today],
    );
    if (!claim.rowCount) continue;
    const { rows: reviewers } = await pool.query(
      `SELECT email, first_name FROM users
        WHERE organization_id = $1 AND status = 'active' AND can_review_reports AND email_notifications`,
      [org.id],
    );
    for (const r of reviewers) {
      sendMail({
        to: r.email,
        subject: `${org.name}: confidential reports need attention`,
        text: `Hi ${r.first_name},\n\n${org.pending === 1 ? 'One confidential report needs' : `${org.pending} confidential reports need`} attention (new, or waiting on a reply).\n\nReview them: ${appLink('/reports')}\n\nFor the reporter's protection this email doesn't include any details.\n\n— Synrgy`,
      });
      sent++;
    }
  }
  return sent;
}

/** Start background jobs (called from the server entrypoint, not in tests). */
export function startJobs() {
  const tick = () => background(runReportDigests());
  setTimeout(tick, 30_000).unref();
  setInterval(tick, 15 * 60_000).unref();
}
