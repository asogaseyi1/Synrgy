import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, type WorkSession } from '../api.ts';
import { useMe } from '../auth.tsx';
import { duration } from '../format.ts';
import { useApi } from '../useApi.ts';
import { SessionsTable } from './ClockPage.tsx';

const RANGES = { '7': 'Last 7 days', '14': 'Last 14 days', '31': 'Last 31 days' } as const;
type RangeKey = keyof typeof RANGES;

function rangeQuery(days: RangeKey) {
  const from = new Date(Date.now() - Number(days) * 86_400_000);
  return `from=${encodeURIComponent(from.toISOString())}`;
}

function RangePicker({ value, onChange }: { value: RangeKey; onChange: (v: RangeKey) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as RangeKey)}>
      {Object.entries(RANGES).map(([k, label]) => (
        <option key={k} value={k}>
          {label}
        </option>
      ))}
    </select>
  );
}

interface SessionsResponse {
  sessions: WorkSession[];
  totals: { workedSeconds: number; breakSeconds: number };
}

/** My timesheet, or (with :userId) a team member's. */
export function TimesheetPage() {
  const { userId } = useParams();
  const { organization } = useMe();
  const [range, setRange] = useState<RangeKey>('14');
  const q = `${rangeQuery(range)}${userId ? `&userId=${userId}` : ''}`;
  const { data, error } = useApi(() => api.get<SessionsResponse>(`/time/sessions?${q}`), [q]);

  return (
    <section>
      <div className="page-head">
        <h1>{userId ? 'Timesheet' : 'My timesheet'}</h1>
        <RangePicker value={range} onChange={setRange} />
      </div>
      {userId && <Link to="/team">← Back to team</Link>}
      {error && <p className="error">{error}</p>}
      {data && (
        <>
          <div className="stats">
            <div>
              <span className="muted">Worked</span>
              <strong>{duration(data.totals.workedSeconds)}</strong>
            </div>
            <div>
              <span className="muted">Breaks</span>
              <strong>{duration(data.totals.breakSeconds)}</strong>
            </div>
            <div>
              <span className="muted">Shifts</span>
              <strong>{data.sessions.length}</strong>
            </div>
          </div>
          <SessionsTable sessions={data.sessions} timeZone={organization.timezone} />
        </>
      )}
    </section>
  );
}

interface TeamRow {
  userId: string;
  firstName: string;
  lastName: string;
  role: string;
  sessionCount: number;
  workedSeconds: number;
  clockedIn: boolean;
}

export function TeamPage() {
  const [range, setRange] = useState<RangeKey>('7');
  const q = rangeQuery(range);
  const { data, error } = useApi(() => api.get<{ members: TeamRow[] }>(`/time/team?${q}`), [q]);

  return (
    <section>
      <div className="page-head">
        <h1>Team time</h1>
        <RangePicker value={range} onChange={setRange} />
      </div>
      {error && <p className="error">{error}</p>}
      {data && !data.members.length && <p className="muted">No direct reports yet.</p>}
      {data && data.members.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Now</th>
                <th className="num">Shifts</th>
                <th className="num">Worked</th>
              </tr>
            </thead>
            <tbody>
              {data.members.map((m) => (
                <tr key={m.userId}>
                  <td>
                    <Link to={`/team/${m.userId}`}>
                      {m.firstName} {m.lastName}
                    </Link>
                  </td>
                  <td>{m.clockedIn ? <span className="badge on">Clocked in</span> : <span className="muted">—</span>}</td>
                  <td className="num">{m.sessionCount}</td>
                  <td className="num">{duration(m.workedSeconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
