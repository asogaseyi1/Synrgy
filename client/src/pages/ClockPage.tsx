import { useEffect, useState } from 'react';
import { api, type ClockStatus, type WorkSession } from '../api.ts';
import { useMe } from '../auth.tsx';
import { clockDuration, date, duration, time } from '../format.ts';
import { errorMessage, useApi } from '../useApi.ts';

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function ClockPage() {
  const { user, organization } = useMe();
  const status = useApi(() => api.get<ClockStatus>('/time/status'));
  const today = useApi(() => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    return api.get<{ totals: { workedSeconds: number } }>(`/time/sessions?from=${from.toISOString()}`);
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const now = useNow();

  const act = async (path: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      await api.post<ClockStatus>(path, body);
      await Promise.all([status.reload(), today.reload()]);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const s = status.data;
  const tz = organization.timezone;
  const sinceIn = s?.session ? (now - Date.parse(s.session.clockInAt)) / 1000 : 0;
  const sinceBreak = s?.break ? (now - Date.parse(s.break.startedAt)) / 1000 : 0;

  return (
    <section>
      <h1>Hi, {user.firstName}</h1>
      <div className={`clock-card state-${s?.state ?? 'off'}`}>
        {!s ? (
          <p>Loading…</p>
        ) : s.state === 'off' ? (
          <>
            <p className="state-label">You're clocked out</p>
            <button className="big" disabled={busy} onClick={() => act('/time/clock-in')}>
              Clock in
            </button>
          </>
        ) : (
          <>
            <p className="state-label">
              {s.state === 'on_break' ? 'On break' : 'Working'} · clocked in at {time(s.session!.clockInAt, tz)}
            </p>
            <p className="timer">{clockDuration(s.state === 'on_break' ? sinceBreak : sinceIn)}</p>
            <div className="actions">
              {s.state === 'working' ? (
                <button disabled={busy} className="secondary" onClick={() => act('/time/break/start', { kind: 'unpaid' })}>
                  Start break
                </button>
              ) : (
                <button disabled={busy} className="secondary" onClick={() => act('/time/break/end')}>
                  End break
                </button>
              )}
              <button disabled={busy} className="danger" onClick={() => act('/time/clock-out')}>
                Clock out
              </button>
            </div>
          </>
        )}
        {(error || status.error) && <p className="error">{error ?? status.error}</p>}
      </div>
      {today.data && <p className="muted">Worked today: {duration(today.data.totals.workedSeconds)}</p>}
    </section>
  );
}

export function SessionsTable({ sessions, timeZone }: { sessions: WorkSession[]; timeZone: string }) {
  if (!sessions.length) return <p className="muted">No time recorded in this period.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>In</th>
            <th>Out</th>
            <th>Breaks</th>
            <th className="num">Worked</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id}>
              <td>{date(s.clockInAt, timeZone)}</td>
              <td>{time(s.clockInAt, timeZone)}</td>
              <td>{s.clockOutAt ? time(s.clockOutAt, timeZone) : <span className="badge">open</span>}</td>
              <td>{s.breaks.length ? duration(s.unpaidBreakSeconds + s.paidBreakSeconds) : '—'}</td>
              <td className="num">{duration(s.workedSeconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
