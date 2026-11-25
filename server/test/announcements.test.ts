import { describe, expect, it } from 'vitest';
import { addMember, newOrg } from './helpers.ts';

const H = 3_600_000;
const at = (hours: number) => new Date(Date.now() + hours * H).toISOString();

async function setup() {
  const org = await newOrg();
  const mgr = await addMember(org.owner, 'manager', 'Mgr');
  const amy = await addMember(org.owner, 'employee', 'Amy'); // Mgr's report
  const ben = await addMember(org.owner, 'employee', 'Ben'); // not on Mgr's team
  await org.owner.patch(`/api/members/${amy.user.id}`).send({ managerId: mgr.user.id });
  const post = (agent: typeof org.owner, body: Record<string, unknown>) =>
    agent.post('/api/announcements').send({ title: 'Hello', body: 'Body text', ...body });
  const feed = async (agent: typeof org.owner) =>
    (await agent.get('/api/announcements')).body.announcements as { id: string; title: string; readAt: string | null }[];
  return { ...org, mgr, amy, ben, post, feed };
}

describe('announcements', () => {
  it('org-wide posts reach everyone; unread count clears after reading', async () => {
    const { owner, amy, ben, post, feed } = await setup();
    const { body } = await post(owner, { title: 'Holiday hours' });
    expect(body.announcement.stats).toEqual({ recipients: 3, read: 0, acknowledged: 0 });

    expect((await amy.agent.get('/api/announcements/unread-count')).body).toEqual({ unread: 1, needsAck: 0 });
    expect(await feed(ben.agent)).toHaveLength(1);
    // Authors don't count as their own audience.
    expect((await owner.get('/api/announcements/unread-count')).body.unread).toBe(0);

    await amy.agent.post('/api/announcements/read').send({ ids: [body.announcement.id] });
    expect((await amy.agent.get('/api/announcements/unread-count')).body.unread).toBe(0);
    const managed = (await owner.get('/api/announcements/manage')).body.announcements[0];
    expect(managed.stats.read).toBe(1);
  });

  it('targets by role and by team', async () => {
    const { owner, mgr, amy, ben, post, feed } = await setup();
    await post(owner, { title: 'Managers only', audienceRoles: ['manager'] });
    await post(owner, { title: "Mgr's team", audienceTeamOf: mgr.user.id });

    expect((await feed(mgr.agent)).map((a) => a.title).sort()).toEqual(['Managers only', "Mgr's team"]);
    expect((await feed(amy.agent)).map((a) => a.title)).toEqual(["Mgr's team"]);
    expect(await feed(ben.agent)).toHaveLength(0);
  });

  it('managers can only post to their own team and manage their own posts', async () => {
    const { owner, ownerUser, mgr, amy, ben, post, feed } = await setup();
    expect((await post(amy.agent, {})).status).toBe(403);
    expect((await post(mgr.agent, { audienceTeamOf: ownerUser.id })).status).toBe(403);

    const res = await post(mgr.agent, { title: 'Team huddle' }); // team defaults to the manager's own
    expect(res.status).toBe(201);
    expect(res.body.announcement.audienceTeam.id).toBe(mgr.user.id);
    expect(await feed(amy.agent)).toHaveLength(1);
    expect(await feed(ben.agent)).toHaveLength(0);

    const ownerPost = (await post(owner, {})).body.announcement.id;
    expect((await mgr.agent.patch(`/api/announcements/${ownerPost}`).send({ pinned: true })).status).toBe(403);
    expect((await mgr.agent.get('/api/announcements/manage')).body.announcements).toHaveLength(1);
  });

  it('scheduled posts stay hidden until publish time; expired ones move to the archive', async () => {
    const { owner, amy, post, feed } = await setup();
    const scheduled = (await post(owner, { title: 'Later', publishAt: at(48) })).body.announcement;
    expect(scheduled.state).toBe('scheduled');
    expect(await feed(amy.agent)).toHaveLength(0);
    expect((await amy.agent.post('/api/announcements/read').send({ ids: [scheduled.id] })).body.marked).toBe(0);

    // Move it into the past window: published yesterday, expired an hour ago.
    await owner.patch(`/api/announcements/${scheduled.id}`).send({ publishAt: at(-24), expiresAt: at(-1) });
    expect(await feed(amy.agent)).toHaveLength(0);
    const archive = (await amy.agent.get('/api/announcements?archived=1')).body.announcements;
    expect(archive).toHaveLength(1);

    expect((await post(owner, { publishAt: at(5), expiresAt: at(2) })).status).toBe(400);
  });

  it('pinned posts sort first', async () => {
    const { owner, amy, post, feed } = await setup();
    await post(owner, { title: 'Old pinned', pinned: true, publishAt: at(-5) });
    await post(owner, { title: 'Newest' });
    expect((await feed(amy.agent)).map((a) => a.title)).toEqual(['Old pinned', 'Newest']);
  });

  it('acknowledgement: required, recorded, reset when content changes', async () => {
    const { owner, amy, ben, post } = await setup();
    const plain = (await post(owner, {})).body.announcement.id;
    expect((await amy.agent.post(`/api/announcements/${plain}/acknowledge`)).status).toBe(400);

    const policy = (await post(owner, { title: 'Code of conduct v2', requiresAck: true })).body.announcement.id;
    expect((await amy.agent.get('/api/announcements/unread-count')).body.needsAck).toBe(1);
    const ack = await amy.agent.post(`/api/announcements/${policy}/acknowledge`);
    expect(ack.body.acknowledgedAt).toBeTruthy();
    expect((await amy.agent.get('/api/announcements/unread-count')).body.needsAck).toBe(0);

    const receipts = (await owner.get(`/api/announcements/${policy}/receipts`)).body.receipts as { id: string; acknowledgedAt: string | null }[];
    expect(receipts.find((r) => r.id === amy.user.id)!.acknowledgedAt).toBeTruthy();
    expect(receipts.find((r) => r.id === ben.user.id)!.acknowledgedAt).toBeNull();

    // Pinning doesn't reset; editing the text does.
    await owner.patch(`/api/announcements/${policy}`).send({ pinned: true });
    expect((await amy.agent.get('/api/announcements/unread-count')).body.needsAck).toBe(0);
    const edited = await owner.patch(`/api/announcements/${policy}`).send({ body: 'Updated section 4' });
    expect(edited.body.announcement.editedAt).toBeTruthy();
    expect(edited.body.announcement.stats.acknowledged).toBe(0);
    expect((await amy.agent.get('/api/announcements/unread-count')).body.needsAck).toBe(1);
  });

  it('is isolated between organizations', async () => {
    const a = await setup();
    const b = await newOrg();
    const id = (await a.post(a.owner, {})).body.announcement.id;
    expect((await b.owner.get('/api/announcements')).body.announcements).toHaveLength(0);
    expect((await b.owner.patch(`/api/announcements/${id}`).send({ pinned: true })).status).toBe(404);
    expect((await b.owner.delete(`/api/announcements/${id}`)).status).toBe(404);
    expect((await a.owner.delete(`/api/announcements/${id}`)).status).toBe(204);
  });
});
