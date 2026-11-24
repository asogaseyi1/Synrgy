import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { addMember, app, newOrg } from './helpers.ts';

describe('organizations & auth', () => {
  it('registers an org and returns the owner session', async () => {
    const { owner, ownerUser, organization } = await newOrg();
    expect(ownerUser.role).toBe('owner');
    expect(organization.timezone).toBe('America/Chicago');
    const me = await owner.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(ownerUser.id);
  });

  it('rejects a duplicate workspace slug', async () => {
    const { slug } = await newOrg();
    const res = await request(app).post('/api/auth/register-organization').send({
      organizationName: 'Dup', slug, firstName: 'A', lastName: 'B', email: 'a@b.test', password: 'password123',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('slug_taken');
  });

  it('validates input', async () => {
    const res = await request(app).post('/api/auth/register-organization').send({ slug: 'X!' });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toHaveProperty('slug');
  });

  it('logs in by workspace + email and logs out', async () => {
    const { slug } = await newOrg();
    const agent = request.agent(app);
    const bad = await agent.post('/api/auth/login').send({ workspace: slug, email: `owner@${slug}.test`, password: 'nope-nope' });
    expect(bad.status).toBe(401);
    const ok = await agent.post('/api/auth/login').send({ workspace: slug, email: `OWNER@${slug}.test`, password: 'password123' });
    expect(ok.status).toBe(200);
    expect((await agent.get('/api/auth/me')).status).toBe(200);
    await agent.post('/api/auth/logout');
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });
});

describe('members', () => {
  it('invites and accepts members', async () => {
    const { owner, slug } = await newOrg();
    const { user, email } = await addMember(owner, 'manager', 'Mia');
    expect(user.role).toBe('manager');
    const list = await owner.get('/api/members');
    expect(list.body.members).toHaveLength(2);
    // The new member can log in.
    const login = await request(app).post('/api/auth/login').send({ workspace: slug, email, password: 'password123' });
    expect(login.status).toBe(200);
  });

  it('keeps organizations isolated', async () => {
    const a = await newOrg();
    const b = await newOrg();
    const { user } = await addMember(b.owner);
    const res = await a.owner.patch(`/api/members/${user.id}`).send({ role: 'manager' });
    expect(res.status).toBe(404);
    const list = await a.owner.get('/api/members');
    expect(list.body.members.map((m: { id: string }) => m.id)).not.toContain(user.id);
  });

  it('enforces roles', async () => {
    const { owner } = await newOrg();
    const emp = await addMember(owner);
    expect((await emp.agent.get('/api/members')).status).toBe(403);
    expect((await emp.agent.post('/api/members/invitations').send({ email: 'x@y.test' })).status).toBe(403);

    const admin = await addMember(owner, 'admin', 'Ada');
    const res = await admin.agent.post('/api/members/invitations').send({ email: 'z@y.test', role: 'admin' });
    expect(res.status).toBe(403);
  });

  it('deactivation revokes sessions', async () => {
    const { owner } = await newOrg();
    const emp = await addMember(owner);
    expect((await emp.agent.get('/api/auth/me')).status).toBe(200);
    await owner.patch(`/api/members/${emp.user.id}`).send({ status: 'deactivated' });
    expect((await emp.agent.get('/api/auth/me')).status).toBe(401);
  });

  it('an invitation can only be used once', async () => {
    const { owner } = await newOrg();
    const inv = await owner.post('/api/members/invitations').send({ email: 'once@x.test' });
    const body = { firstName: 'A', lastName: 'B', password: 'password123' };
    expect((await request(app).post(`/api/invitations/${inv.body.token}/accept`).send(body)).status).toBe(201);
    expect((await request(app).post(`/api/invitations/${inv.body.token}/accept`).send(body)).status).toBe(404);
  });
});
