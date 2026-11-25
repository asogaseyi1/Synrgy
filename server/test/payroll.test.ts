import { describe, expect, it } from 'vitest';
import { pool } from '../src/db.ts';
import { computePayroll, csvCell, paySession, roundTime, weekOf, type PayRules, type PunchSession } from '../src/lib/payroll.ts';
import { addMember, newOrg } from './helpers.ts';

const H = 3600;
const TZ = 'America/Chicago';
const RULES: PayRules = {
  roundingMinutes: 0,
  autoBreakAfterHours: null,
  autoBreakMinutes: 30,
  dailyOvertimeHours: null,
  weeklyOvertimeHours: 40,
  weekStartsOn: 1,
};

let n = 0;
/** A session at local Chicago time (CST, UTC-6, in November 2026). */
function sess(day: string, from: string, to: string, unpaidMin = 0, userId = 'u1'): PunchSession {
  return {
    id: `s${n++}`,
    userId,
    clockInAt: new Date(`${day}T${from}:00-06:00`),
    clockOutAt: new Date(`${day}T${to}:00-06:00`),
    unpaidBreakSeconds: unpaidMin * 60,
    paidBreakSeconds: 0,
  };
}

describe('payroll rules (unit)', () => {
  it('rounds to the nearest increment', () => {
    expect(roundTime(new Date('2026-11-02T14:07:00Z'), 15).toISOString()).toBe('2026-11-02T14:00:00.000Z');
    expect(roundTime(new Date('2026-11-02T14:08:00Z'), 15).toISOString()).toBe('2026-11-02T14:15:00.000Z');
    const pay = paySession(sess('2026-11-02', '08:07', '16:53'), { ...RULES, roundingMinutes: 15 }, TZ);
    expect(pay.paidSeconds).toBe(9 * H);
  });

  it('auto-deducts only the break shortfall on long shifts', () => {
    const rules = { ...RULES, autoBreakAfterHours: 6, autoBreakMinutes: 30 };
    expect(paySession(sess('2026-11-02', '08:00', '16:00', 10), rules, TZ)).toMatchObject({ autoDeductSeconds: 20 * 60, paidSeconds: 7.5 * H });
    expect(paySession(sess('2026-11-02', '08:00', '16:00', 45), rules, TZ).autoDeductSeconds).toBe(0);
    expect(paySession(sess('2026-11-02', '08:00', '13:00'), rules, TZ).autoDeductSeconds).toBe(0); // under 6h
  });

  it('daily overtime, then weekly overtime on the remaining straight time', () => {
    // Mon–Fri, 10h a day = 50h.
    const week = ['02', '03', '04', '05', '06'].map((d) => sess(`2026-11-${d}`, '08:00', '18:00'));
    const daily = computePayroll(week, { ...RULES, dailyOvertimeHours: 8 }, TZ).people.get('u1')!;
    expect(daily).toMatchObject({ paidSeconds: 50 * H, dailyOvertimeSeconds: 10 * H, weeklyOvertimeSeconds: 0, regularSeconds: 40 * H });

    const weekly = computePayroll(week, RULES, TZ).people.get('u1')!;
    expect(weekly).toMatchObject({ dailyOvertimeSeconds: 0, weeklyOvertimeSeconds: 10 * H, overtimeSeconds: 10 * H });

    const none = computePayroll(week, { ...RULES, weeklyOvertimeHours: null }, TZ).people.get('u1')!;
    expect(none.overtimeSeconds).toBe(0);
  });

  it('weeks follow the org week start', () => {
    expect(weekOf('2026-11-08', 1)).toBe('2026-11-02'); // Sunday belongs to the Monday week
    expect(weekOf('2026-11-08', 0)).toBe('2026-11-08'); // ...or starts its own
    // 6 × 8h Mon–Sat, plus 8h on Sunday the 8th.
    const days = ['02', '03', '04', '05', '06', '07', '08'].map((d) => sess(`2026-11-${d}`, '08:00', '16:00'));
    expect(computePayroll(days, RULES, TZ).people.get('u1')!.weeklyOvertimeSeconds).toBe(16 * H);
    expect(computePayroll(days, { ...RULES, weekStartsOn: 0 }, TZ).people.get('u1')!.weeklyOvertimeSeconds).toBe(8 * H);
  });

  it('assigns overnight shifts to the day they started (org time zone)', () => {
    const night = sess('2026-11-02', '22:00', '23:59');
    expect(paySession(night, RULES, TZ).day).toBe('2026-11-02'); // 04:00Z on the 3rd
  });

  it('CSV cells are quoted and protected from formula injection', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell(null)).toBe('');
  });
});

describe('payroll API & export', () => {
  async function setup() {
    const org = await newOrg(); // America/Chicago
    const mgr = await addMember(org.owner, 'manager', 'Mgr');
    const amy = await addMember(org.owner, 'employee', 'Amy');
    const ben = await addMember(org.owner, 'employee', 'Ben');
    await org.owner.patch(`/api/members/${amy.user.id}`).send({ managerId: mgr.user.id });
    for (const d of ['02', '03', '04', '05', '06']) {
      await pool.query(
        `INSERT INTO work_sessions (organization_id, user_id, clock_in_at, clock_out_at) VALUES ($1, $2, $3, $4)`,
        [org.organization.id, amy.user.id, `2026-11-${d}T08:00:00-06:00`, `2026-11-${d}T18:00:00-06:00`],
      );
    }
    await pool.query(`INSERT INTO work_sessions (organization_id, user_id, clock_in_at) VALUES ($1, $2, $3)`, [
      org.organization.id,
      amy.user.id,
      '2026-11-07T08:00:00-06:00',
    ]);
    return { ...org, mgr, amy, ben };
  }
  const q = 'from=2026-11-02&to=2026-11-08';

  it('applies org rules and counts open shifts separately', async () => {
    const { owner, amy } = await setup();
    await owner.patch('/api/organization/settings').send({ dailyOvertimeHours: 8, weeklyOvertimeHours: 40 });
    const res = await owner.get(`/api/time/payroll?${q}`);
    expect(res.status).toBe(200);
    const row = res.body.members.find((m: { id: string }) => m.id === amy.user.id);
    expect(row).toMatchObject({ sessionCount: 5, paidSeconds: 50 * H, regularSeconds: 40 * H, overtimeSeconds: 10 * H, openSessions: 1 });
    expect(res.body.rules.dailyOvertimeHours).toBe(8);
  });

  it('scopes managers to their reports; employees are refused', async () => {
    const { mgr, amy, ben } = await setup();
    const ids = (await mgr.agent.get(`/api/time/payroll?${q}`)).body.members.map((m: { id: string }) => m.id);
    expect(ids).toContain(amy.user.id);
    expect(ids).not.toContain(ben.user.id);
    expect((await ben.agent.get(`/api/time/payroll?${q}`)).status).toBe(403);
    expect((await mgr.agent.get('/api/time/payroll?from=2026-01-01&to=2026-12-31')).status).toBe(400); // > 93 days
  });

  it('exports summary and detail CSV, and audits the export', async () => {
    const { owner, slug, organization } = await setup();
    const summary = await owner.get(`/api/time/export?${q}&format=summary`);
    expect(summary.headers['content-type']).toContain('text/csv');
    expect(summary.headers['content-disposition']).toContain(`${slug}-summary-2026-11-02-to-2026-11-08.csv`);
    const lines = summary.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toContain('Overtime hours');
    expect(lines.find((l) => l.startsWith('Amy Test'))).toContain('50.00');

    const detail = await owner.get(`/api/time/export?${q}&format=detail`);
    const rows = detail.text.trim().split('\r\n').filter((l) => l.startsWith('Amy Test'));
    expect(rows).toHaveLength(5); // the open shift is excluded
    expect(rows[0]).toContain('2026-11-02 08:00');

    const audit = await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE organization_id = $1 AND action = 'time.exported'`, [organization.id]);
    expect(audit.rows[0].n).toBe(2);
  });

  it('filters by department', async () => {
    const { owner, amy } = await setup();
    const dept = (await owner.post('/api/organization/units').send({ kind: 'department', name: 'Kitchen' })).body.unit;
    await owner.patch(`/api/members/${amy.user.id}`).send({ departmentId: dept.id });
    const res = await owner.get(`/api/time/payroll?${q}&departmentId=${dept.id}`);
    expect(res.body.members.map((m: { id: string }) => m.id)).toEqual([amy.user.id]);
    expect(res.body.members[0].department).toBe('Kitchen');
  });
});
