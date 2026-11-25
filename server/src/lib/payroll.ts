import type { OrgSettings } from './settings.ts';

/**
 * Payroll calculation. Pure functions over completed sessions: raw punches are never modified,
 * rules are applied on the way out (timesheet summaries and CSV export).
 *
 * Per session:  round in/out → span − unpaid breaks − auto-deducted break shortfall = paid time.
 * Per person:   paid time is grouped by the local day of clock-in; daily overtime is time over the
 *               daily threshold; weekly overtime is remaining (non-daily-OT) time over the weekly threshold.
 */

export type PayRules = Pick<
  OrgSettings,
  'roundingMinutes' | 'autoBreakAfterHours' | 'autoBreakMinutes' | 'dailyOvertimeHours' | 'weeklyOvertimeHours' | 'weekStartsOn'
>;

export interface PunchSession {
  id: string;
  userId: string;
  clockInAt: Date;
  clockOutAt: Date;
  unpaidBreakSeconds: number;
  paidBreakSeconds: number;
}

export interface SessionPay {
  roundedIn: Date;
  roundedOut: Date;
  autoDeductSeconds: number;
  paidSeconds: number;
  day: string;
}

export interface PersonPay {
  userId: string;
  sessionCount: number;
  paidSeconds: number;
  regularSeconds: number;
  overtimeSeconds: number;
  dailyOvertimeSeconds: number;
  weeklyOvertimeSeconds: number;
  unpaidBreakSeconds: number;
  paidBreakSeconds: number;
  autoDeductSeconds: number;
  days: Record<string, number>;
}

export function roundTime(t: Date, minutes: number): Date {
  if (!minutes) return t;
  const step = minutes * 60_000;
  return new Date(Math.round(t.getTime() / step) * step);
}

/** YYYY-MM-DD of an instant in a time zone. */
export function localDay(t: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
}

/** First day (YYYY-MM-DD) of the week containing `ymd`. */
export function weekOf(ymd: string, weekStartsOn: 0 | 1): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  const back = (d.getUTCDay() - weekStartsOn + 7) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

export function paySession(s: PunchSession, rules: PayRules, timeZone: string): SessionPay {
  const roundedIn = roundTime(s.clockInAt, rules.roundingMinutes);
  const roundedOut = roundTime(s.clockOutAt, rules.roundingMinutes);
  const span = Math.max(0, (roundedOut.getTime() - roundedIn.getTime()) / 1000);
  const autoDeductSeconds =
    rules.autoBreakAfterHours != null && span >= rules.autoBreakAfterHours * 3600
      ? Math.max(0, rules.autoBreakMinutes * 60 - s.unpaidBreakSeconds)
      : 0;
  const paidSeconds = Math.max(0, Math.round(span - s.unpaidBreakSeconds - autoDeductSeconds));
  return { roundedIn, roundedOut, autoDeductSeconds, paidSeconds, day: localDay(s.clockInAt, timeZone) };
}

export function computePayroll(sessions: PunchSession[], rules: PayRules, timeZone: string) {
  const bySession = new Map<string, SessionPay>();
  const people = new Map<string, PersonPay>();

  for (const s of sessions) {
    const pay = paySession(s, rules, timeZone);
    bySession.set(s.id, pay);
    let p = people.get(s.userId);
    if (!p) {
      p = {
        userId: s.userId,
        sessionCount: 0,
        paidSeconds: 0,
        regularSeconds: 0,
        overtimeSeconds: 0,
        dailyOvertimeSeconds: 0,
        weeklyOvertimeSeconds: 0,
        unpaidBreakSeconds: 0,
        paidBreakSeconds: 0,
        autoDeductSeconds: 0,
        days: {},
      };
      people.set(s.userId, p);
    }
    p.sessionCount++;
    p.paidSeconds += pay.paidSeconds;
    p.unpaidBreakSeconds += s.unpaidBreakSeconds;
    p.paidBreakSeconds += s.paidBreakSeconds;
    p.autoDeductSeconds += pay.autoDeductSeconds;
    p.days[pay.day] = (p.days[pay.day] ?? 0) + pay.paidSeconds;
  }

  const dailyLimit = rules.dailyOvertimeHours != null ? rules.dailyOvertimeHours * 3600 : Infinity;
  const weeklyLimit = rules.weeklyOvertimeHours != null ? rules.weeklyOvertimeHours * 3600 : Infinity;

  for (const p of people.values()) {
    const weeks = new Map<string, number>(); // straight time remaining after daily OT
    for (const [day, seconds] of Object.entries(p.days)) {
      const dailyOt = Math.max(0, seconds - dailyLimit);
      p.dailyOvertimeSeconds += dailyOt;
      const wk = weekOf(day, rules.weekStartsOn);
      weeks.set(wk, (weeks.get(wk) ?? 0) + seconds - dailyOt);
    }
    for (const straight of weeks.values()) p.weeklyOvertimeSeconds += Math.max(0, straight - weeklyLimit);
    p.overtimeSeconds = p.dailyOvertimeSeconds + p.weeklyOvertimeSeconds;
    p.regularSeconds = p.paidSeconds - p.overtimeSeconds;
  }

  return { bySession, people };
}

// ---------- CSV ----------

/** Quote a CSV cell and neutralise spreadsheet formula injection (=, +, -, @ at the start). */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

export const hours = (seconds: number) => (seconds / 3600).toFixed(2);
