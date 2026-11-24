import { describe, expect, it } from 'vitest';
import { addMember, newOrg } from './helpers.ts';

const H = 3_600_000;
/** Hours from now → ISO. */
const at = (hours: number) => new Date(Date.now() + hours * H).toISOString();
const range = `from=${encodeURIComponent(at(-24))}&to=${encodeURIComponent(at(24 * 20))}`;

async function setup() {
  const org = await newOrg();
  const mgr = await addMember(org.owner, 'manager', 'Mgr');
  const amy = await addMember(org.owner, 'employee', 'Amy');
  const ben = await addMember(org.owner, 'employee', 'Ben');
  for (const p of [amy, ben]) await org.owner.patch(`/api/members/${p.user.id}`).send({ managerId: mgr.user.id });

  const shift = async (userId: string | null, startH: number, lenH = 8) => {
    const res = await mgr.agent.post('/api/shifts').send({ userId, startsAt: at(startH), endsAt: at(startH + lenH), position: 'Cashier' });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return res.body.shift.id as string;
  };
  const publish = () => mgr.agent.post('/api/shifts/publish').send({ from: at(-24), to: at(24 * 30) });
  return { ...org, mgr, amy, ben, shift, publish };
}

describe('scheduling', () => {
  it('drafts are hidden from employees until published', async () => {
    const { amy, shift, publish } = await setup();
    await shift(amy.user.id, 24);
    expect((await amy.agent.get(`/api/shifts?${range}`)).body.shifts).toHaveLength(0);
    expect((await publish()).body.published).toBe(1);
    const res = await amy.agent.get(`/api/shifts?${range}`);
    expect(res.body.shifts).toHaveLength(1);
    expect(res.body.shifts[0].isDraft).toBe(false);
    expect((await amy.agent.get('/api/shifts/upcoming')).body.shifts).toHaveLength(1);
  });

  it('prevents double-booking at the database level', async () => {
    const { mgr, amy, shift } = await setup();
    await shift(amy.user.id, 24);
    const res = await mgr.agent.post('/api/shifts').send({ userId: amy.user.id, startsAt: at(30), endsAt: at(36) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('schedule_conflict');
    // Open shifts can overlap freely.
    await shift(null, 24);
    await shift(null, 24);
  });

  it('enforces who can schedule whom', async () => {
    const { owner, amy, mgr } = await setup();
    const stranger = await addMember(owner, 'employee', 'Str'); // not Mgr's report
    expect((await amy.agent.post('/api/shifts').send({ startsAt: at(24), endsAt: at(30) })).status).toBe(403);
    expect((await mgr.agent.post('/api/shifts').send({ userId: stranger.user.id, startsAt: at(24), endsAt: at(30) })).status).toBe(403);
    expect((await owner.post('/api/shifts').send({ userId: stranger.user.id, startsAt: at(24), endsAt: at(30) })).status).toBe(201);
    expect((await mgr.agent.post('/api/shifts').send({ startsAt: at(30), endsAt: at(24) })).status).toBe(400);
  });

  it('cover: coworker accepts, manager approves, shift moves', async () => {
    const { mgr, amy, ben, shift, publish } = await setup();
    const id = await shift(amy.user.id, 48);
    await publish();

    const create = await amy.agent.post('/api/swaps').send({ shiftId: id, type: 'cover', targetUserId: ben.user.id, message: 'Doctor appt' });
    expect(create.status).toBe(201);
    const swapId = create.body.swap.id;

    expect((await ben.agent.get('/api/swaps/counts')).body.incoming).toBe(1);
    const accept = await ben.agent.post(`/api/swaps/${swapId}/accept`);
    expect(accept.body.swap.status).toBe('pending_manager');

    // Parties can't approve their own swap.
    expect((await ben.agent.post(`/api/swaps/${swapId}/approve`)).status).toBe(403);
    expect((await mgr.agent.get('/api/swaps/counts')).body.review).toBe(1);
    const approve = await mgr.agent.post(`/api/swaps/${swapId}/approve`);
    expect(approve.body.swap.status).toBe('approved');

    const shifts = (await ben.agent.get(`/api/shifts?${range}`)).body.shifts;
    expect(shifts.find((s: { id: string }) => s.id === id).user.id).toBe(ben.user.id);
  });

  it('swap: two shifts trade owners', async () => {
    const { mgr, amy, ben, shift, publish } = await setup();
    const a = await shift(amy.user.id, 48);
    const b = await shift(ben.user.id, 72);
    await publish();
    const { body } = await amy.agent.post('/api/swaps').send({ shiftId: a, type: 'swap', targetShiftId: b });
    expect(body.swap.targetUser.id).toBe(ben.user.id);
    await ben.agent.post(`/api/swaps/${body.swap.id}/accept`);
    await mgr.agent.post(`/api/swaps/${body.swap.id}/approve`);

    const shifts = (await mgr.agent.get(`/api/shifts?${range}`)).body.shifts as { id: string; user: { id: string } }[];
    expect(shifts.find((s) => s.id === a)!.user.id).toBe(ben.user.id);
    expect(shifts.find((s) => s.id === b)!.user.id).toBe(amy.user.id);
  });

  it('swap of overlapping shifts works (no transient constraint violation)', async () => {
    const { owner, mgr, amy, ben, shift, publish } = await setup();
    await owner.patch('/api/organization/settings').send({ requireSwapApproval: false });
    const a = await shift(amy.user.id, 48);
    const b = await shift(ben.user.id, 50); // overlaps a
    await publish();
    const { body } = await amy.agent.post('/api/swaps').send({ shiftId: a, type: 'swap', targetShiftId: b });
    const res = await ben.agent.post(`/api/swaps/${body.swap.id}/accept`);
    expect(res.body.swap.status).toBe('approved');
    expect(res.body.swap.reviewer).toBeNull();
    void mgr;
  });

  it('open offer: anyone can pick it up; manager approval can be turned off', async () => {
    const { owner, amy, ben, shift, publish } = await setup();
    await owner.patch('/api/organization/settings').send({ requireSwapApproval: false });
    const id = await shift(amy.user.id, 48);
    await publish();
    const { body } = await amy.agent.post('/api/swaps').send({ shiftId: id, type: 'open' });
    expect((await amy.agent.post(`/api/swaps/${body.swap.id}/accept`)).status).toBe(400);

    const list = await ben.agent.get('/api/swaps');
    expect(list.body.available).toHaveLength(1);
    const claim = await ben.agent.post(`/api/swaps/${body.swap.id}/accept`);
    expect(claim.body.swap.status).toBe('approved');
    expect(claim.body.swap.acceptedBy.id).toBe(ben.user.id);
  });

  it('blocks takers who are already busy, at request time and at pickup', async () => {
    const { amy, ben, shift, publish } = await setup();
    const a = await shift(amy.user.id, 48);
    await shift(ben.user.id, 50); // Ben busy at the same time
    await publish();

    const clash = await amy.agent.post('/api/swaps').send({ shiftId: a, type: 'cover', targetUserId: ben.user.id });
    expect(clash.body.error.code).toBe('schedule_conflict');

    const open = await amy.agent.post('/api/swaps').send({ shiftId: a, type: 'open' });
    const claim = await ben.agent.post(`/api/swaps/${open.body.swap.id}/accept`);
    expect(claim.body.error.code).toBe('schedule_conflict');
  });

  it('weekly cap is enforced within one week', async () => {
    const { owner, amy, ben, mgr, publish } = await setup();
    await owner.patch('/api/organization/settings').send({ maxWeeklyHours: 10 });
    // Two shifts on the same day, far enough out to be safely in the future.
    const base = new Date(Date.now() + 14 * 24 * H);
    base.setUTCHours(12, 0, 0, 0);
    const iso = (offsetH: number) => new Date(base.getTime() + offsetH * H).toISOString();
    const a = (await mgr.agent.post('/api/shifts').send({ userId: amy.user.id, startsAt: iso(0), endsAt: iso(4) })).body.shift.id;
    await mgr.agent.post('/api/shifts').send({ userId: ben.user.id, startsAt: iso(-8), endsAt: iso(-1) });
    await publish();
    const res = await amy.agent.post('/api/swaps').send({ shiftId: a, type: 'cover', targetUserId: ben.user.id });
    expect(res.body.error.code).toBe('over_hours');
  });

  it('decline, cancel, and manager edits cancel pending swaps', async () => {
    const { mgr, amy, ben, shift, publish } = await setup();
    const id = await shift(amy.user.id, 48);
    await publish();
    const s1 = (await amy.agent.post('/api/swaps').send({ shiftId: id, type: 'cover', targetUserId: ben.user.id })).body.swap;
    expect((await ben.agent.post(`/api/swaps/${s1.id}/decline`)).body.swap.status).toBe('declined');

    const s2 = (await amy.agent.post('/api/swaps').send({ shiftId: id, type: 'open' })).body.swap;
    expect((await amy.agent.post('/api/swaps').send({ shiftId: id, type: 'open' })).body.error.code).toBe('already_pending');
    expect((await amy.agent.post(`/api/swaps/${s2.id}/cancel`)).body.swap.status).toBe('cancelled');

    const s3 = (await amy.agent.post('/api/swaps').send({ shiftId: id, type: 'open' })).body.swap;
    await mgr.agent.patch(`/api/shifts/${id}`).send({ position: 'Stock' });
    const mine = (await amy.agent.get('/api/swaps')).body.mine as { id: string; status: string }[];
    expect(mine.find((s) => s.id === s3.id)!.status).toBe('cancelled');
  });

  it("can't swap someone else's, past, or draft shifts", async () => {
    const { amy, ben, shift, publish } = await setup();
    const benShift = await shift(ben.user.id, 48);
    const draft = await shift(amy.user.id, 24 * 6);
    expect((await amy.agent.post('/api/swaps').send({ shiftId: benShift, type: 'open' })).status).toBe(404);
    expect((await amy.agent.post('/api/swaps').send({ shiftId: draft, type: 'open' })).status).toBe(400);
    const past = await shift(amy.user.id, -12, 4);
    await publish();
    expect((await amy.agent.post('/api/swaps').send({ shiftId: past, type: 'open' })).status).toBe(400);
  });
});
