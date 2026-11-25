import { pool } from '../db.ts';
import { appLink, background, sendMail } from './mailer.ts';

/*
 * Email notifications for workflow events. Each function is fire-and-forget: it loads what it needs
 * after the triggering transaction has committed, and respects users' email_notifications preference.
 * Nothing here ever touches anonymous reports except the daily, content-free digest in jobs.ts.
 */

interface Recipient {
  id: string;
  email: string;
  first_name: string;
}

const KIND_LABELS: Record<string, string> = {
  missed_shift: 'missed shift',
  missed_clock_in: 'missed clock-in',
  missed_clock_out: 'missed clock-out',
  missed_break: 'missed break',
  wrong_time: 'wrong time',
};

function when(ts: Date, timeZone: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(ts);
}

async function recipients(ids: (string | null | undefined)[]): Promise<Recipient[]> {
  const list = ids.filter((x): x is string => !!x);
  if (!list.length) return [];
  const { rows } = await pool.query(
    `SELECT id, email, first_name FROM users WHERE id = ANY($1::uuid[]) AND status = 'active' AND email_notifications`,
    [list],
  );
  return rows;
}

/** Who approves requests from `userId`: their active manager, or the org's admins if they have none. */
async function approversOf(organizationId: string, userId: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT a.id FROM users a
      WHERE a.organization_id = $1 AND a.status = 'active' AND a.id <> $2
        AND (a.id = (SELECT m.id FROM users x JOIN users m ON m.id = x.manager_id AND m.status = 'active' WHERE x.id = $2)
             OR (a.role IN ('admin', 'owner') AND NOT EXISTS (
                   SELECT 1 FROM users x JOIN users m ON m.id = x.manager_id AND m.status = 'active' WHERE x.id = $2)))`,
    [organizationId, userId],
  );
  return rows.map((r) => r.id);
}

function send(to: Recipient[], subject: string, body: (r: Recipient) => string) {
  for (const r of to) sendMail({ to: r.email, subject, text: `Hi ${r.first_name},\n\n${body(r)}\n\n— Synrgy` });
}

// ---------- Accounts ----------

export function invitationEmail(to: string, orgName: string, inviter: string, url: string) {
  sendMail({
    to,
    subject: `${inviter} invited you to ${orgName} on Synrgy`,
    text: `Hi,\n\n${inviter} invited you to join ${orgName} on Synrgy, where you'll clock in, see your schedule and get announcements.\n\nAccept the invitation: ${url}\n\nThe link expires in a few days. If you weren't expecting this, you can ignore it.\n\n— Synrgy`,
  });
}

export function passwordResetEmail(to: string, firstName: string, orgName: string, url: string, minutes: number) {
  sendMail({
    to,
    subject: `Reset your ${orgName} password`,
    text: `Hi ${firstName},\n\nSomeone (hopefully you) asked to reset your Synrgy password for ${orgName}.\n\nChoose a new password: ${url}\n\nThis link works once and expires in ${minutes} minutes. If you didn't ask for this, ignore this email; your password won't change.\n\n— Synrgy`,
  });
}

// ---------- Shift swaps ----------

async function loadSwap(id: string) {
  const { rows } = await pool.query(
    `SELECT sw.*, s.starts_at, s.ends_at, o.timezone,
            rq.first_name || ' ' || rq.last_name AS requester_name,
            ac.first_name || ' ' || ac.last_name AS accepted_name
       FROM shift_swaps sw
       JOIN scheduled_shifts s ON s.id = sw.shift_id
       JOIN organizations o ON o.id = sw.organization_id
       JOIN users rq ON rq.id = sw.requester_id
       LEFT JOIN users ac ON ac.id = sw.accepted_by
      WHERE sw.id = $1`,
    [id],
  );
  return rows[0];
}

export function swapRequested(swapId: string) {
  background(
    (async () => {
      const sw = await loadSwap(swapId);
      if (!sw || sw.type === 'open') return; // open offers would be noise for everyone
      const ask = sw.type === 'cover' ? 'asked you to cover their shift' : 'wants to swap shifts with you';
      send(await recipients([sw.target_user_id]), `${sw.requester_name} ${ask}`, () =>
        `${sw.requester_name} ${ask} on ${when(sw.starts_at, sw.timezone)}.${sw.message ? `\n\n“${sw.message}”` : ''}\n\nRespond: ${appLink('/swaps')}`,
      );
    })(),
  );
}

export function swapNeedsApproval(swapId: string) {
  background(
    (async () => {
      const sw = await loadSwap(swapId);
      if (!sw || sw.status !== 'pending_manager') return;
      const ids = new Set([...(await approversOf(sw.organization_id, sw.requester_id)), ...(await approversOf(sw.organization_id, sw.accepted_by))]);
      ids.delete(sw.requester_id);
      ids.delete(sw.accepted_by);
      send(await recipients([...ids]), `Shift swap waiting for approval`, () =>
        `${sw.requester_name} and ${sw.accepted_name} agreed to a ${sw.type === 'swap' ? 'shift swap' : 'shift handover'} on ${when(sw.starts_at, sw.timezone)}. It needs your approval.\n\nReview: ${appLink('/approvals?tab=swaps')}`,
      );
    })(),
  );
}

export function swapDecided(swapId: string) {
  background(
    (async () => {
      const sw = await loadSwap(swapId);
      if (!sw) return;
      const outcome = { approved: 'was approved', rejected: 'was rejected', declined: 'was declined' }[sw.status as string];
      if (!outcome) return;
      const to = sw.status === 'declined' ? [sw.requester_id] : [sw.requester_id, sw.accepted_by];
      send(await recipients(to), `Your shift swap ${outcome}`, () =>
        `The request for the shift on ${when(sw.starts_at, sw.timezone)} ${outcome}.${sw.review_note ? `\n\nNote: ${sw.review_note}` : ''}\n\nSee your schedule: ${appLink('/schedule')}`,
      );
    })(),
  );
}

// ---------- Time corrections ----------

async function loadException(id: string) {
  const { rows } = await pool.query(
    `SELECT pe.*, u.first_name || ' ' || u.last_name AS requester_name, o.timezone
       FROM punch_exceptions pe JOIN users u ON u.id = pe.user_id JOIN organizations o ON o.id = pe.organization_id
      WHERE pe.id = $1`,
    [id],
  );
  return rows[0];
}

export function exceptionSubmitted(exceptionId: string) {
  background(
    (async () => {
      const ex = await loadException(exceptionId);
      if (!ex) return;
      const label = KIND_LABELS[ex.kind] ?? 'time correction';
      send(await recipients(await approversOf(ex.organization_id, ex.user_id)), `${ex.requester_name} requested a time correction`, () =>
        `${ex.requester_name} reported a ${label} for ${when(ex.requested_clock_in_at, ex.timezone)}.\n\nReason: ${ex.reason}\n\nReview: ${appLink('/approvals')}`,
      );
    })(),
  );
}

export function exceptionDecided(exceptionId: string) {
  background(
    (async () => {
      const ex = await loadException(exceptionId);
      if (!ex || !['approved', 'rejected'].includes(ex.status)) return;
      send(await recipients([ex.user_id]), `Your time correction was ${ex.status}`, () =>
        `Your ${KIND_LABELS[ex.kind] ?? 'time correction'} request for ${when(ex.requested_clock_in_at, ex.timezone)} was ${ex.status}.${ex.review_note ? `\n\nNote: ${ex.review_note}` : ''}\n\nSee your requests: ${appLink('/requests')}`,
      );
    })(),
  );
}
