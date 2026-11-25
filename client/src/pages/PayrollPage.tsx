import { useState } from 'react';
import { api, atLeast, type OrgUnit } from '../api.ts';
import { useMe } from '../auth.tsx';
import { duration } from '../format.ts';
import { addDays, dayKey, formatDay, weekStartOf } from '../tz.ts';
import { useApi } from '../useApi.ts';

interface PayrollRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  status: 'active' | 'deactivated';
  department: string | null;
  location: string | null;
  openSessions: number;
  sessionCount: number;
  paidSeconds: number;
  regularSeconds: number;
  overtimeSeconds: number;
  dailyOvertimeSeconds: number;
  weeklyOvertimeSeconds: number;
  unpaidBreakSeconds: number;
  paidBreakSeconds: number;
  autoDeductSeconds: number;
}

interface Payroll {
  from: string;
  to: string;
  rules: {
    roundingMinutes: number;
    autoBreakAfterHours: number | null;
    autoBreakMinutes: number;
    dailyOvertimeHours: number | null;
    weeklyOvertimeHours: number | null;
    weekStartsOn: 0 | 1;
  };
  members: PayrollRow[];
}

const hrs = (s: number) => (s / 3600).toFixed(2);

function rulesSummary(r: Payroll['rules']) {
  const parts = [
    r.roundingMinutes ? `punches rounded to ${r.roundingMinutes} min` : 'exact punches',
    r.autoBreakAfterHours != null ? `${r.autoBreakMinutes} min break auto-deducted after ${r.autoBreakAfterHours}h` : null,
    r.dailyOvertimeHours != null ? `overtime after ${r.dailyOvertimeHours}h/day` : null,
    r.weeklyOvertimeHours != null ? `overtime after ${r.weeklyOvertimeHours}h/week` : null,
    `weeks start ${r.weekStartsOn === 0 ? 'Sunday' : 'Monday'}`,
  ];
  return parts.filter(Boolean).join(' · ');
}

export function PayrollPage() {
  const { user, organization } = useMe();
  const tz = organization.timezone;
  const today = dayKey(new Date(), tz);
  const thisWeek = weekStartOf(today, organization.weekStartsOn ?? 1);
  const presets = [
    { label: 'This week', from: thisWeek, to: addDays(thisWeek, 6) },
    { label: 'Last week', from: addDays(thisWeek, -7), to: addDays(thisWeek, -1) },
    { label: 'Last 2 weeks', from: addDays(thisWeek, -14), to: addDays(thisWeek, -1) },
    { label: 'This month', from: `${today.slice(0, 8)}01`, to: today },
  ];
  const [from, setFrom] = useState(presets[1].from);
  const [to, setTo] = useState(presets[1].to);
  const [departmentId, setDepartmentId] = useState('');
  const [locationId, setLocationId] = useState('');
  const units = useApi(() => api.get<{ units: OrgUnit[] }>('/organization/units'));
  const departments = units.data?.units.filter((u) => u.kind === 'department') ?? [];
  const locations = units.data?.units.filter((u) => u.kind === 'location') ?? [];

  const query = new URLSearchParams({ from, to });
  if (departmentId) query.set('departmentId', departmentId);
  if (locationId) query.set('locationId', locationId);
  const qs = query.toString();
  const { data, error } = useApi(() => api.get<Payroll>(`/time/payroll?${qs}`), [qs]);

  const rows = data?.members.filter((m) => m.sessionCount > 0 || m.status === 'active') ?? [];
  const total = rows.reduce(
    (t, m) => ({ paid: t.paid + m.paidSeconds, regular: t.regular + m.regularSeconds, ot: t.ot + m.overtimeSeconds, open: t.open + m.openSessions }),
    { paid: 0, regular: 0, ot: 0, open: 0 },
  );

  return (
    <section>
      <div className="page-head">
        <div>
          <p className="eyebrow">{atLeast(user.role, 'admin') ? 'Everyone' : 'Your team'}</p>
          <h1>Payroll</h1>
        </div>
        <div className="toolbar">
          <a className="button secondary" href={`/api/time/export?${qs}&format=detail`} download>
            Download detail CSV
          </a>
          <a className="button" href={`/api/time/export?${qs}&format=summary`} download>
            Download summary CSV
          </a>
        </div>
      </div>

      <div className="card filters">
        <div className="tabs small-tabs">
          {presets.map((p) => (
            <button key={p.label} className={p.from === from && p.to === to ? 'active' : ''} onClick={() => (setFrom(p.from), setTo(p.to))}>
              {p.label}
            </button>
          ))}
        </div>
        <label className="inline-label">
          From
          <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </label>
        <label className="inline-label">
          To
          <input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </label>
        {departments.length > 0 && (
          <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} aria-label="Department">
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        )}
        {locations.length > 0 && (
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)} aria-label="Location">
            <option value="">All locations</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {error && <p className="error" role="alert">{error}</p>}
      {data && (
        <>
          <p className="muted small">
            {formatDay(from)} – {formatDay(to)} · {rulesSummary(data.rules)}
            {atLeast(user.role, 'admin') && ' · change these in Settings'}
          </p>
          <div className="stats">
            <div className="stat">
              <span>Paid hours</span>
              <strong>{hrs(total.paid)}</strong>
            </div>
            <div className="stat">
              <span>Regular</span>
              <strong>{hrs(total.regular)}</strong>
            </div>
            <div className="stat">
              <span>Overtime</span>
              <strong>{hrs(total.ot)}</strong>
            </div>
          </div>
          {total.open > 0 && (
            <div className="banner">
              <div>
                <strong>{total.open} shift{total.open === 1 ? ' is' : 's are'} still open</strong>
                <div className="small">Open shifts aren't counted. Ask people to clock out or file a correction before exporting.</div>
              </div>
            </div>
          )}
          {rows.length === 0 ? (
            <p className="empty">Nobody to show for these filters.</p>
          ) : (
            <div className="table-wrap">
              <table className="payroll">
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Shifts</th>
                    <th className="num">Paid</th>
                    <th className="num">Regular</th>
                    <th className="num">Overtime</th>
                    <th className="num">Breaks</th>
                    <th className="num" title="Auto-deducted break time">Auto-deduct</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((m) => (
                    <tr key={m.id} className={m.status === 'deactivated' ? 'inactive' : undefined}>
                      <td>
                        {m.firstName} {m.lastName}
                        <div className="muted small">{[m.department, m.location].filter(Boolean).join(' · ') || m.email}</div>
                      </td>
                      <td>
                        {m.sessionCount}
                        {m.openSessions > 0 && <span className="badge status-pending"> +{m.openSessions} open</span>}
                      </td>
                      <td className="num">{hrs(m.paidSeconds)}</td>
                      <td className="num">{hrs(m.regularSeconds)}</td>
                      <td className={`num${m.overtimeSeconds ? ' ot' : ''}`}>{hrs(m.overtimeSeconds)}</td>
                      <td className="num muted">{duration(m.unpaidBreakSeconds + m.paidBreakSeconds)}</td>
                      <td className="num muted">{m.autoDeductSeconds ? duration(m.autoDeductSeconds) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
