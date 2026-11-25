import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { pool } from '../src/db.ts';
import { addMember, app, newOrg } from './helpers.ts';

const anon = () => request(app); // no cookies at all

const submit = (slug: string, body: Record<string, unknown> = {}) =>
  anon()
    .post(`/api/public/reports/orgs/${slug}/reports`)
    .send({ category: 'Health and safety', description: 'The fire exit on floor 2 is always blocked.', ...body });

async function setup() {
  const org = await newOrg(); // the owner is a reviewer by default
  const emp = await addMember(org.owner, 'employee', 'Emp');
  const admin = await addMember(org.owner, 'admin', 'Adm');
  const filed = await submit(org.slug);
  expect(filed.status).toBe(201);
  const cred = { workspace: org.slug, trackingCode: filed.body.trackingCode, accessKey: filed.body.accessKey };
  const { rows } = await pool.query('SELECT id FROM reports WHERE tracking_code = $1', [cred.trackingCode.replace(/-/g, '')]);
  return { ...org, emp, admin, cred, reportId: rows[0].id as string };
}

describe('anonymous reporting', () => {
  it('stores nothing that identifies the reporter', async () => {
    const cols = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name IN ('reports', 'report_messages')`,
    );
    const names = cols.rows.map((c) => c.column_name as string);
    for (const banned of ['user_id', 'reporter_id', 'ip', 'ip_address', 'user_agent', 'session_id', 'created_at']) {
      expect(names).not.toContain(banned);
    }
    // Only day-precision dates.
    const dateTypes = await pool.query(
      `SELECT DISTINCT data_type FROM information_schema.columns
        WHERE table_name IN ('reports', 'report_messages') AND data_type LIKE 'time%'`,
    );
    expect(dateTypes.rows).toHaveLength(0);
  });

  it('a signed-in employee submitting leaves no trace linking them', async () => {
    const { slug, emp, ownerUser } = await setup();
    const before = (await pool.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n;
    // Even if the session cookie is sent, the public route ignores it.
    const res = await emp.agent.post(`/api/public/reports/orgs/${slug}/reports`).send({
      category: 'Retaliation',
      description: 'Something happened after I raised a concern.',
    });
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const after = (await pool.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n;
    expect(after).toBe(before);
    const row = (await pool.query('SELECT to_jsonb(r) AS j FROM reports r WHERE tracking_code = $1', [res.body.trackingCode.replace(/-/g, '')])).rows[0].j;
    expect(JSON.stringify(row)).not.toContain(emp.user.id);
    expect(JSON.stringify(row)).not.toContain(ownerUser.id);
  });

  it('reporter can check in with code + key (forgiving input), not with a wrong key', async () => {
    const { cred } = await setup();
    expect(cred.trackingCode).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    expect(cred.accessKey).toMatch(/^([0-9A-Z]{4}-){4}[0-9A-Z]{4}$/);

    const ok = await anon()
      .post('/api/public/reports/access')
      .send({ ...cred, trackingCode: cred.trackingCode.toLowerCase().replace('-', ' '), accessKey: cred.accessKey.replace(/-/g, '') });
    expect(ok.status).toBe(200);
    expect(ok.body.report.status).toBe('new');
    expect(ok.body.report.createdOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const wrong = await anon().post('/api/public/reports/access').send({ ...cred, accessKey: 'AAAA-AAAA-AAAA-AAAA-AAAA' });
    expect(wrong.status).toBe(404);
    const otherOrg = await newOrg();
    expect((await anon().post('/api/public/reports/access').send({ ...cred, workspace: otherOrg.slug })).status).toBe(404);
  });

  it('only designated reviewers can read reports, and every open is audited', async () => {
    const { owner, emp, admin, reportId } = await setup();
    expect((await emp.agent.get('/api/reports')).status).toBe(403);
    expect((await admin.agent.get('/api/reports')).status).toBe(403); // admin isn't automatically a reviewer

    const inbox = await owner.get('/api/reports');
    expect(inbox.body.reports).toHaveLength(1);
    expect(inbox.body.reports[0].description).toBeUndefined(); // content only via the audited view
    expect((await owner.get('/api/reports/counts')).body.needsAttention).toBe(1);

    await owner.get(`/api/reports/${reportId}`);
    const detail = await owner.get(`/api/reports/${reportId}`);
    expect(detail.body.report.description).toContain('fire exit');
    expect(detail.body.report.accessLog.filter((a: { action: string }) => a.action === 'report.viewed')).toHaveLength(2);

    // Granting the flag takes effect immediately.
    await owner.patch(`/api/members/${admin.user.id}`).send({ canReviewReports: true });
    expect((await admin.agent.get(`/api/reports/${reportId}`)).status).toBe(200);
  });

  it('two-way anonymous messaging; investigators stay unnamed to the reporter', async () => {
    const { owner, ownerUser, cred, reportId } = await setup();
    const reply = await owner.post(`/api/reports/${reportId}/messages`).send({ body: 'Thanks — which exit exactly?' });
    expect(reply.body.report.status).toBe('investigating');
    expect(reply.body.report.messages[0].reviewer.id).toBe(ownerUser.id);
    expect((await owner.get('/api/reports/counts')).body.needsAttention).toBe(0);

    const seen = await anon().post('/api/public/reports/access').send(cred);
    expect(seen.body.report.messages).toEqual([
      { seq: 1, author: 'reviewer', body: 'Thanks — which exit exactly?', createdOn: expect.any(String) },
    ]);
    expect(JSON.stringify(seen.body)).not.toContain(ownerUser.id);

    const back = await anon().post('/api/public/reports/messages').send({ ...cred, body: 'The east stairwell.' });
    expect(back.body.report.messages.map((m: { author: string }) => m.author)).toEqual(['reviewer', 'reporter']);
    expect((await owner.get('/api/reports/counts')).body.needsAttention).toBe(1);
  });

  it('closing turns off reporter messages; reopening turns them back on', async () => {
    const { owner, cred, reportId } = await setup();
    const closed = await owner.patch(`/api/reports/${reportId}`).send({ status: 'resolved' });
    expect(closed.body.report.closedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await anon().post('/api/public/reports/messages').send({ ...cred, body: 'hello?' })).status).toBe(400);
    expect((await owner.get('/api/reports?status=closed')).body.reports).toHaveLength(1);

    await owner.patch(`/api/reports/${reportId}`).send({ status: 'investigating' });
    expect((await anon().post('/api/public/reports/messages').send({ ...cred, body: 'hello?' })).status).toBe(200);
    const log = (await owner.get(`/api/reports/${reportId}`)).body.report.accessLog as { action: string }[];
    expect(log.filter((a) => a.action === 'report.status_changed')).toHaveLength(2);
  });

  it('categories come from org settings', async () => {
    const { slug, owner } = await setup();
    expect((await submit(slug, { category: 'Made up' })).status).toBe(400);
    await owner.patch('/api/organization/settings').send({ reportCategories: ['Food safety', 'Other', 'Other'] });
    const form = await anon().get(`/api/public/reports/orgs/${slug}`);
    expect(form.body.categories).toEqual(['Food safety', 'Other']);
    expect((await submit(slug, { category: 'Food safety' })).status).toBe(201);
    expect((await submit(slug, { description: 'short' })).status).toBe(400);
    expect((await anon().get('/api/public/reports/orgs/does-not-exist')).status).toBe(404);
  });

  it('is isolated between organizations', async () => {
    const a = await setup();
    const b = await newOrg();
    expect((await b.owner.get('/api/reports')).body.reports).toHaveLength(0);
    expect((await b.owner.get(`/api/reports/${a.reportId}`)).status).toBe(404);
    expect((await b.owner.post(`/api/reports/${a.reportId}/messages`).send({ body: 'x' })).status).toBe(404);
  });
});
