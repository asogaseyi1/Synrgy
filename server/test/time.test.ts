import { describe, expect, it } from 'vitest';
import { addMember, newOrg } from './helpers.ts';

describe('time clock', () => {
  it('runs through clock-in, break, clock-out', async () => {
    const { owner } = await newOrg();
    const { agent } = await addMember(owner);

    expect((await agent.get('/api/time/status')).body.state).toBe('off');

    const inRes = await agent.post('/api/time/clock-in');
    expect(inRes.status).toBe(201);
    expect(inRes.body.state).toBe('working');

    expect((await agent.post('/api/time/clock-in')).body.error.code).toBe('already_clocked_in');

    const br = await agent.post('/api/time/break/start').send({ kind: 'unpaid' });
    expect(br.body.state).toBe('on_break');
    expect((await agent.post('/api/time/break/start')).status).toBe(409);

    expect((await agent.post('/api/time/break/end')).body.state).toBe('working');
    expect((await agent.post('/api/time/break/end')).body.error.code).toBe('not_on_break');

    expect((await agent.post('/api/time/clock-out')).body.state).toBe('off');
    expect((await agent.post('/api/time/clock-out')).body.error.code).toBe('not_clocked_in');

    const sheet = await agent.get('/api/time/sessions');
    expect(sheet.status).toBe(200);
    expect(sheet.body.sessions).toHaveLength(1);
    expect(sheet.body.sessions[0].breaks).toHaveLength(1);
    expect(sheet.body.sessions[0].clockOutAt).not.toBeNull();
  });

  it('clocking out closes an open break', async () => {
    const { owner } = await newOrg();
    const { agent } = await addMember(owner);
    await agent.post('/api/time/clock-in');
    await agent.post('/api/time/break/start');
    await agent.post('/api/time/clock-out');
    const sheet = await agent.get('/api/time/sessions');
    expect(sheet.body.sessions[0].breaks[0].endedAt).not.toBeNull();
  });

  it('cannot start a break while clocked out', async () => {
    const { owner } = await newOrg();
    const { agent } = await addMember(owner);
    expect((await agent.post('/api/time/break/start')).body.error.code).toBe('not_clocked_in');
  });

  it('managers see their direct reports only; employees see only themselves', async () => {
    const { owner } = await newOrg();
    const mgr = await addMember(owner, 'manager', 'Mgr');
    const report = await addMember(owner, 'employee', 'Rep');
    const other = await addMember(owner, 'employee', 'Oth');
    await owner.patch(`/api/members/${report.user.id}`).send({ managerId: mgr.user.id });
    await report.agent.post('/api/time/clock-in');

    expect((await mgr.agent.get(`/api/time/sessions?userId=${report.user.id}`)).status).toBe(200);
    expect((await mgr.agent.get(`/api/time/sessions?userId=${other.user.id}`)).status).toBe(403);
    expect((await other.agent.get(`/api/time/sessions?userId=${report.user.id}`)).status).toBe(403);
    expect((await other.agent.get('/api/time/team')).status).toBe(403);

    const team = await mgr.agent.get('/api/time/team');
    expect(team.body.members.map((m: { userId: string }) => m.userId)).toEqual([report.user.id]);
    expect(team.body.members[0].clockedIn).toBe(true);

    const all = await owner.get('/api/time/team');
    expect(all.body.members).toHaveLength(4);
  });

  it('rejects oversized ranges', async () => {
    const { owner } = await newOrg();
    const res = await owner.get('/api/time/sessions?from=2026-01-01T00:00:00Z&to=2026-12-01T00:00:00Z');
    expect(res.status).toBe(400);
  });
});
