import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.ts';

export const app = createApp();

/** Register a fresh organization; returns an agent logged in as its owner. */
export async function newOrg() {
  const slug = `t-${randomUUID().slice(0, 8)}`;
  const owner = request.agent(app);
  const res = await owner.post('/api/auth/register-organization').send({
    organizationName: 'Test Co',
    slug,
    timezone: 'America/Chicago',
    firstName: 'Olu',
    lastName: 'Owner',
    email: `owner@${slug}.test`,
    password: 'password123',
  });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  return { slug, owner, ownerUser: res.body.user, organization: res.body.organization };
}

/** Invite and accept a member; returns an agent logged in as them. */
export async function addMember(owner: ReturnType<typeof request.agent>, role = 'employee', name = 'Emp') {
  const email = `${name.toLowerCase()}-${randomUUID().slice(0, 6)}@example.test`;
  const inv = await owner.post('/api/members/invitations').send({ email, role });
  if (inv.status !== 201) throw new Error(`invite failed: ${JSON.stringify(inv.body)}`);
  const agent = request.agent(app);
  const acc = await agent
    .post(`/api/invitations/${inv.body.token}/accept`)
    .send({ firstName: name, lastName: 'Test', password: 'password123' });
  if (acc.status !== 201) throw new Error(`accept failed: ${JSON.stringify(acc.body)}`);
  return { agent, user: acc.body.user, email };
}
