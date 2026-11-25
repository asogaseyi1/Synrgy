import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db.ts';
import { runReportDigests } from '../src/lib/jobs.ts';
import { flushMail, outbox } from '../src/lib/mailer.ts';
import { setRateLimitsEnabled } from '../src/middleware/security.ts';
import { addMember, app, newOrg } from './helpers.ts';

const mailTo = (email: string) => outbox.filter((m) => m.to.toLowerCase() === email.toLowerCase());
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

beforeEach(() => {
  outbox.length = 0;
});

describe('org settings', () => {
  it('validates values and drives the time clock rules', async () => {
    const { owner, organization } = await newOrg();
    expect((await owner.patch('/api/organization/settings').send({ roundingMinutes: 7 })).status).toBe(400);
    expect((await owner.patch('/api/organization/settings').send({ weekStartsOn: 3 })).status).toBe(400);
    const emp = await addMember(owner, 'employee', 'Emp');
    expect((await emp.agent.patch('/api/organization/settings').send({ staleOpenHours: 8 })).status).toBe(403);

    // A 5h-old open shift becomes "stale" once the threshold is 4h.
    await pool.query('INSERT INTO work_sessions (organization_id, user_id, clock_in_at) VALUES ($1, $2, $3)', [organization.id, emp.user.id, ago(5)]);
    expect((await emp.agent.get('/api/time/status')).body.stale).toBe(false);
    await owner.patch('/api/organization/settings').send({ staleOpenHours: 4 });
    expect((await emp.agent.get('/api/time/status')).body.stale).toBe(true);

    // Correction window.
    await owner.patch('/api/organization/settings').send({ correctionWindowDays: 1 });
    const res = await emp.agent.post('/api/exceptions').send({
      kind: 'missed_shift',
      clockInAt: ago(72),
      clockOutAt: ago(66),
      reason: 'Forgot my phone',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('1 days');
  });

  it('admins can rename the workspace and change its time zone; week start reaches /me', async () => {
    const { owner } = await newOrg();
    expect((await owner.patch('/api/organization').send({ timezone: 'Mars/Olympus' })).status).toBe(400);
    const res = await owner.patch('/api/organization').send({ name: 'Renamed Co', timezone: 'Europe/Berlin' });
    expect(res.body.organization).toMatchObject({ name: 'Renamed Co', timezone: 'Europe/Berlin' });
    await owner.patch('/api/organization/settings').send({ weekStartsOn: 0 });
    expect((await owner.get('/api/auth/me')).body.organization.weekStartsOn).toBe(0);
  });
});

describe('departments & locations', () => {
  it('admins manage them; members are assigned; announcements can target them', async () => {
    const { owner } = await newOrg();
    const amy = await addMember(owner, 'employee', 'Amy');
    const ben = await addMember(owner, 'employee', 'Ben');
    const kitchen = (await owner.post('/api/organization/units').send({ kind: 'department', name: 'Kitchen' })).body.unit;
    const downtown = (await owner.post('/api/organization/units').send({ kind: 'location', name: 'Downtown' })).body.unit;
    expect((await owner.post('/api/organization/units').send({ kind: 'department', name: 'kitchen' })).status).toBe(409);
    expect((await amy.agent.post('/api/organization/units').send({ kind: 'department', name: 'X' })).status).toBe(403);

    // Kind must match.
    expect((await owner.patch(`/api/members/${amy.user.id}`).send({ departmentId: downtown.id })).status).toBe(400);
    const m = await owner.patch(`/api/members/${amy.user.id}`).send({ departmentId: kitchen.id, locationId: downtown.id });
    expect(m.body.member).toMatchObject({ departmentId: kitchen.id, locationId: downtown.id });
    const units = (await amy.agent.get('/api/organization/units')).body.units;
    expect(units.find((u: { id: string }) => u.id === kitchen.id).memberCount).toBe(1);

    const ann = await owner.post('/api/announcements').send({ title: 'Kitchen only', body: 'New knives', audienceDepartmentId: kitchen.id });
    expect(ann.body.announcement.audienceDepartment.name).toBe('Kitchen');
    expect((await amy.agent.get('/api/announcements')).body.announcements).toHaveLength(1);
    expect((await ben.agent.get('/api/announcements')).body.announcements).toHaveLength(0);

    // Deleting a unit unassigns members.
    expect((await owner.delete(`/api/organization/units/${kitchen.id}`)).status).toBe(204);
    expect((await owner.get('/api/members')).body.members.find((x: { id: string }) => x.id === amy.user.id).departmentId).toBeNull();
  });
});

describe('email notifications', () => {
  it('invitations, corrections and swaps send email; users can opt out', async () => {
    const { owner, ownerUser } = await newOrg();
    const inv = await owner.post('/api/members/invitations').send({ email: 'new.person@example.test', role: 'employee' });
    await flushMail();
    const invite = mailTo('new.person@example.test');
    expect(invite).toHaveLength(1);
    expect(invite[0].text).toContain(`/invite/${inv.body.token}`);

    // Exception with no manager → admins/owner get it.
    const emp = await addMember(owner, 'employee', 'Emp');
    outbox.length = 0;
    const ex = await emp.agent.post('/api/exceptions').send({ kind: 'missed_shift', clockInAt: ago(30), clockOutAt: ago(24), reason: 'Phone died' });
    expect(ex.status).toBe(201);
    await flushMail();
    expect(mailTo(ownerUser.email)[0].subject).toContain('requested a time correction');

    await owner.post(`/api/exceptions/${ex.body.exception.id}/approve`).send({});
    await flushMail();
    expect(mailTo(emp.email)[0].subject).toBe('Your time correction was approved');

    // Opt out.
    await emp.agent.patch('/api/auth/me').send({ emailNotifications: false });
    outbox.length = 0;
    const ex2 = await emp.agent.post('/api/exceptions').send({ kind: 'missed_shift', clockInAt: ago(54), clockOutAt: ago(48), reason: 'Again' });
    await owner.post(`/api/exceptions/${ex2.body.exception.id}/reject`).send({ note: 'No record' });
    await flushMail();
    expect(mailTo(emp.email)).toHaveLength(0);
  });

  it('report digest: daily, content-free, once per day', async () => {
    const { slug, ownerUser } = await newOrg();
    await request(app)
      .post(`/api/public/reports/orgs/${slug}/reports`)
      .send({ category: 'Other', description: 'Secret details that must not be emailed.' });
    expect(mailTo(ownerUser.email)).toHaveLength(0); // nothing at submit time

    const nineAmChicago = new Date();
    nineAmChicago.setUTCHours(15, 0, 0, 0);
    await runReportDigests(nineAmChicago);
    await flushMail();
    const digest = mailTo(ownerUser.email);
    expect(digest).toHaveLength(1);
    expect(digest[0].text).toContain('One confidential report needs attention');
    expect(digest[0].text).not.toContain('Secret details');

    await runReportDigests(nineAmChicago);
    await flushMail();
    expect(mailTo(ownerUser.email)).toHaveLength(1);

    const sixAm = new Date(nineAmChicago.getTime() + 21 * 3_600_000); // next day, 06:00 local: too early
    await runReportDigests(sixAm);
    await flushMail();
    expect(mailTo(ownerUser.email)).toHaveLength(1);
  });
});

describe('passwords', () => {
  it('reset by email: one-time link, signs out everywhere, no account discovery', async () => {
    const { slug, owner, ownerUser } = await newOrg();
    const anon = request.agent(app);
    expect((await anon.post('/api/auth/password-reset').send({ workspace: slug, email: 'nobody@example.test' })).body).toEqual({ ok: true });
    await flushMail();
    expect(outbox).toHaveLength(0);

    await anon.post('/api/auth/password-reset').send({ workspace: slug, email: ownerUser.email.toUpperCase() });
    await flushMail();
    const token = /\/reset\/([\w-]+)/.exec(mailTo(ownerUser.email)[0].text)![1];
    expect((await anon.get(`/api/auth/password-reset/${token}`)).body.firstName).toBe('Olu');
    expect((await anon.post(`/api/auth/password-reset/${token}`).send({ password: 'short' })).status).toBe(400);

    const done = await anon.post(`/api/auth/password-reset/${token}`).send({ password: 'brand-new-pass' });
    expect(done.status).toBe(200);
    expect((await anon.get('/api/auth/me')).status).toBe(200); // signed in with the new session
    expect((await owner.get('/api/auth/me')).status).toBe(401); // old session revoked
    expect((await anon.post(`/api/auth/password-reset/${token}`).send({ password: 'another-pass' })).status).toBe(404);

    const login = await request(app).post('/api/auth/login').send({ workspace: slug, email: ownerUser.email, password: 'brand-new-pass' });
    expect(login.status).toBe(200);
  });

  it('change password keeps this session and ends the others', async () => {
    const { slug, owner, ownerUser } = await newOrg();
    const other = request.agent(app);
    await other.post('/api/auth/login').send({ workspace: slug, email: ownerUser.email, password: 'password123' });
    expect((await owner.post('/api/auth/password').send({ currentPassword: 'nope', newPassword: 'whatever123' })).status).toBe(400);
    expect((await owner.post('/api/auth/password').send({ currentPassword: 'password123', newPassword: 'whatever123' })).status).toBe(204);
    expect((await owner.get('/api/auth/me')).status).toBe(200);
    expect((await other.get('/api/auth/me')).status).toBe(401);
  });
});

describe('request security', () => {
  afterEach(() => setRateLimitsEnabled(false));

  it('blocks cross-site form posts and foreign origins', async () => {
    const { owner } = await newOrg();
    const form = await owner.post('/api/time/clock-in').set('Content-Type', 'application/x-www-form-urlencoded').send('notes=x');
    expect(form.status).toBe(415);
    const text = await owner.post('/api/time/clock-in').set('Content-Type', 'text/plain').send('{}');
    expect(text.status).toBe(415);
    const evil = await owner.post('/api/time/clock-in').set('Origin', 'https://evil.example').send({});
    expect(evil.status).toBe(403);
    expect((await owner.post('/api/time/clock-in').set('Origin', 'null').send({})).status).toBe(403);
    expect((await owner.post('/api/time/clock-in').set('Origin', 'http://localhost:5173').send({})).status).toBe(201);
    // Reads aren't affected.
    expect((await owner.get('/api/time/status').set('Origin', 'https://evil.example')).status).toBe(200);
  });

  it('rate-limits repeated failed logins per account', async () => {
    const { slug, ownerUser } = await newOrg();
    setRateLimitsEnabled(true);
    const attempt = () => request(app).post('/api/auth/login').send({ workspace: slug, email: ownerUser.email, password: 'wrong-password' });
    for (let i = 0; i < 10; i++) expect((await attempt()).status).toBe(401);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeTruthy();
    expect(blocked.body.error.code).toBe('rate_limited');
  });
});
