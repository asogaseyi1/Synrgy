import { describe, expect, it } from 'vitest';
import { pool } from '../src/db.ts';
import { addMember, newOrg } from './helpers.ts';

const H = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * H).toISOString();

async function seedSession(orgId: string, userId: string, inHoursAgo: number, outHoursAgo: number | null) {
  const { rows } = await pool.query(
    `INSERT INTO work_sessions (organization_id, user_id, clock_in_at, clock_out_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [orgId, userId, ago(inHoursAgo), outHoursAgo === null ? null : ago(outHoursAgo)],
  );
  return rows[0].id as string;
}

/** Org with a manager, their direct report, and an unrelated employee. */
async function setup() {
  const org = await newOrg();
  const mgr = await addMember(org.owner, 'manager', 'Mgr');
  const emp = await addMember(org.owner, 'employee', 'Emp');
  const other = await addMember(org.owner, 'employee', 'Oth');
  await org.owner.patch(`/api/members/${emp.user.id}`).send({ managerId: mgr.user.id });
  return { ...org, orgId: org.organization.id as string, mgr, emp, other };
}

describe('punch exceptions', () => {
  it('missed clock-out: manager approves and the session is corrected', async () => {
    const { orgId, mgr, emp } = await setup();
    const sessionId = await seedSession(orgId, emp.user.id, 30, null); // forgot to clock out 30h ago

    const status = await emp.agent.get('/api/time/status');
    expect(status.body.stale).toBe(true);

    const create = await emp.agent.post('/api/exceptions').send({
      kind: 'missed_clock_out',
      workSessionId: sessionId,
      clockInAt: ago(30),
      clockOutAt: ago(22),
      breaks: [{ startedAt: ago(26), endedAt: ago(25.5), kind: 'unpaid' }],
      reason: 'Forgot to clock out before leaving',
    });
    expect(create.status).toBe(201);
    const ex = create.body.exception;
    expect(ex.status).toBe('pending');
    expect(ex.original.clockOutAt).toBeNull();

    const sheet = await emp.agent.get('/api/time/sessions?from=' + encodeURIComponent(ago(48)));
    expect(sheet.body.sessions[0].pendingExceptionId).toBe(ex.id);

    const count = await mgr.agent.get('/api/exceptions/review-count');
    expect(count.body.pending).toBe(1);

    const approve = await mgr.agent.post(`/api/exceptions/${ex.id}/approve`).send({ note: 'OK' });
    expect(approve.status).toBe(200);
    expect(approve.body.exception.status).toBe('approved');
    expect(approve.body.exception.reviewer.id).toBe(mgr.user.id);

    const after = await emp.agent.get('/api/time/sessions?from=' + encodeURIComponent(ago(48)));
    const s = after.body.sessions[0];
    expect(s.source).toBe('correction');
    expect(s.clockOutAt).not.toBeNull();
    expect(s.breaks).toHaveLength(1);
    expect(s.workedSeconds).toBeGreaterThan(7.4 * 3600);
    expect(s.workedSeconds).toBeLessThan(7.6 * 3600);
    expect(s.pendingExceptionId).toBeNull();
    expect((await emp.agent.get('/api/time/status')).body.state).toBe('off');

    const { rows } = await pool.query(
      `SELECT data FROM audit_log WHERE action = 'time.corrected' AND entity_id = $1`,
      [sessionId],
    );
    expect(rows[0].data.before.clockOutAt).toBeNull();
    expect(rows[0].data.after.clockOutAt).toBeTruthy();
  });

  it('missed shift: approval creates a new session', async () => {
    const { owner, emp } = await setup();
    const create = await emp.agent.post('/api/exceptions').send({
      kind: 'missed_shift',
      clockInAt: ago(50),
      clockOutAt: ago(42),
      reason: 'Phone died, worked the full shift',
    });
    expect(create.status).toBe(201);
    expect(create.body.exception.original).toBeNull();

    // An admin can approve anyone's request (not just direct reports).
    expect((await owner.post(`/api/exceptions/${create.body.exception.id}/approve`)).status).toBe(200);
    const sheet = await emp.agent.get('/api/time/sessions?from=' + encodeURIComponent(ago(72)));
    expect(sheet.body.sessions).toHaveLength(1);
    expect(sheet.body.sessions[0].source).toBe('correction');
  });

  it('rejection requires a note and leaves the session alone', async () => {
    const { orgId, mgr, emp } = await setup();
    const sessionId = await seedSession(orgId, emp.user.id, 10, 2);
    const { body } = await emp.agent.post('/api/exceptions').send({
      kind: 'wrong_time', workSessionId: sessionId, clockInAt: ago(11), clockOutAt: ago(2), reason: 'Started earlier',
    });
    expect((await mgr.agent.post(`/api/exceptions/${body.exception.id}/reject`).send({})).status).toBe(400);
    const rej = await mgr.agent.post(`/api/exceptions/${body.exception.id}/reject`).send({ note: 'Schedule says 10h ago' });
    expect(rej.body.exception.status).toBe('rejected');
    expect(rej.body.exception.reviewNote).toBe('Schedule says 10h ago');

    const sheet = await emp.agent.get('/api/time/sessions');
    expect(sheet.body.sessions[0].source).toBe('clock');
    // Can't act on it twice.
    expect((await mgr.agent.post(`/api/exceptions/${body.exception.id}/approve`)).status).toBe(409);
  });

  it('enforces who can review', async () => {
    const { owner, orgId, mgr, emp, other } = await setup();
    const { body } = await other.agent.post('/api/exceptions').send({
      kind: 'missed_shift', clockInAt: ago(30), clockOutAt: ago(25), reason: 'Missed it',
    });
    const id = body.exception.id;
    // Manager isn't Oth's manager; employees can't review; nobody sees it in a review list unless allowed.
    expect((await mgr.agent.post(`/api/exceptions/${id}/approve`)).status).toBe(404);
    expect((await emp.agent.post(`/api/exceptions/${id}/approve`)).status).toBe(404);
    expect((await emp.agent.get('/api/exceptions?scope=review')).status).toBe(403);
    const mgrList = await mgr.agent.get('/api/exceptions?scope=review');
    expect(mgrList.body.exceptions).toHaveLength(0);

    // A manager can't approve their own request, even as an admin would.
    const own = await mgr.agent.post('/api/exceptions').send({
      kind: 'missed_shift', clockInAt: ago(30), clockOutAt: ago(25), reason: 'Mine',
    });
    const adminUser = await addMember(owner, 'admin', 'Adm');
    expect((await mgr.agent.post(`/api/exceptions/${own.body.exception.id}/approve`)).status).toBe(403);
    expect((await adminUser.agent.post(`/api/exceptions/${own.body.exception.id}/approve`)).status).toBe(200);

    // Owner's own request cannot be self-approved.
    const ownerReq = await owner.post('/api/exceptions').send({
      kind: 'missed_shift', clockInAt: ago(30), clockOutAt: ago(25), reason: 'Owner forgot',
    });
    expect((await owner.post(`/api/exceptions/${ownerReq.body.exception.id}/approve`)).status).toBe(403);
    void orgId;
  });

  it('validates shape, overlap, ownership and duplicates', async () => {
    const { orgId, emp, other } = await setup();
    const sessionId = await seedSession(orgId, emp.user.id, 10, 2);
    const post = (body: object) => emp.agent.post('/api/exceptions').send({ reason: 'because', ...body });

    expect((await post({ kind: 'missed_shift', clockInAt: ago(2), clockOutAt: ago(3) })).status).toBe(400);
    expect((await post({ kind: 'missed_shift', clockInAt: ago(1), clockOutAt: new Date(Date.now() + H).toISOString() })).status).toBe(400);
    expect((await post({ kind: 'missed_shift', clockInAt: ago(40 * 24), clockOutAt: ago(40 * 24 - 8) })).status).toBe(400);
    expect((await post({ kind: 'missed_shift', clockInAt: ago(60), clockOutAt: ago(30) })).status).toBe(400); // > 24h
    expect(
      (await post({ kind: 'missed_shift', clockInAt: ago(30), clockOutAt: ago(25), breaks: [{ startedAt: ago(31), endedAt: ago(29) }] })).status,
    ).toBe(400);
    expect(
      (await post({
        kind: 'missed_shift', clockInAt: ago(30), clockOutAt: ago(25),
        breaks: [{ startedAt: ago(29), endedAt: ago(28) }, { startedAt: ago(28.5), endedAt: ago(27) }],
      })).status,
    ).toBe(400);
    // Overlaps the existing 10h→2h session.
    const overlap = await post({ kind: 'missed_shift', clockInAt: ago(5), clockOutAt: ago(1) });
    expect(overlap.body.error.code).toBe('overlap');
    // Non-missed_shift needs a session; someone else's session is not found.
    expect((await post({ kind: 'wrong_time', clockInAt: ago(10), clockOutAt: ago(3) })).status).toBe(400);
    const otherSession = await seedSession(orgId, other.user.id, 10, 2);
    expect((await post({ kind: 'wrong_time', workSessionId: otherSession, clockInAt: ago(10), clockOutAt: ago(3) })).status).toBe(404);
    // One pending request per session.
    expect((await post({ kind: 'wrong_time', workSessionId: sessionId, clockInAt: ago(10), clockOutAt: ago(3) })).status).toBe(201);
    const dup = await post({ kind: 'wrong_time', workSessionId: sessionId, clockInAt: ago(10), clockOutAt: ago(4) });
    expect(dup.body.error.code).toBe('already_pending');
  });

  it('employees can cancel their own pending requests', async () => {
    const { emp, other } = await setup();
    const { body } = await emp.agent.post('/api/exceptions').send({
      kind: 'missed_shift', clockInAt: ago(30), clockOutAt: ago(25), reason: 'Oops',
    });
    expect((await other.agent.post(`/api/exceptions/${body.exception.id}/cancel`)).status).toBe(409);
    const res = await emp.agent.post(`/api/exceptions/${body.exception.id}/cancel`);
    expect(res.body.exception.status).toBe('cancelled');
    const mine = await emp.agent.get('/api/exceptions?status=cancelled');
    expect(mine.body.exceptions).toHaveLength(1);
  });
});
