import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, type ClockStatus, type Shift, type WorkSession } from '../api.ts';
import { useMe } from '../auth.tsx';
import { clockDuration, date, duration, time } from '../format.ts';
import { dayKey, formatDay } from '../tz.ts';
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
  const upcoming = useApi(() => api.get<{ shifts: Shift[] }>('/shifts/upcoming'));
  const news = useApi(() => api.get<{ unread: number; needsAck: number }>('/announcements/unread-count'));
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
      <p className="eyebrow">{new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</p>
      <h1>Hi, {user.firstName}</h1>
      {s?.stale && s.session && (
        <div className="banner">
          <div>
            <strong>Did you forget to clock out?</strong>
            <div className="small">
              You've been clocked in since {date(s.session.clockInAt, tz)} at {time(s.session.clockInAt, tz)}.
            </div>
          </div>
          <Link className="button" to={`/requests/new?session=${s.session.id}&kind=missed_clock_out`}>
            Fix this shift
          </Link>
        </div>
      )}
      {!!news.data?.needsAck && (
        <div className="banner">
          <div>
            <strong>
              {news.data.needsAck === 1 ? 'An announcement needs' : `${news.data.needsAck} announcements need`} your acknowledgement
            </strong>
            <div className="small">Please read and confirm policy updates from your employer.</div>
          </div>
          <Link className="button" to="/announcements">
            Review now
          </Link>
        </div>
      )}
      <div className={`clock-card state-${s?.state ?? 'off'}`}>
        {!s ? (
          <p>Loading…</p>
        ) : s.state === 'off' ? (
          <>
            <span className="status-pill">Clocked out</span>
            <p className="state-label">Ready to start your shift?</p>
            <button className="big" disabled={busy} onClick={() => act('/time/clock-in')}>
              Clock in
            </button>
          </>
        ) : (
          <>
            <span className="status-pill">{s.state === 'on_break' ? 'On break' : 'Working'}</span>
            <p className="state-label">
              {s.state === 'on_break' ? 'Break time' : 'Shift time'} · clocked in at {time(s.session!.clockInAt, tz)}
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
              <button disabled={busy} className="complement" onClick={() => act('/time/clock-out')}>
                Clock out
              </button>
            </div>
          </>
        )}
        {(error || status.error) && <p className="error">{error ?? status.error}</p>}
      </div>
      <div className="stats today">
        {today.data && (
          <div className="stat">
            <span>Worked today</span>
            <strong>{duration(today.data.totals.workedSeconds)}</strong>
          </div>
        )}
        {upcoming.data && (
          <Link to="/schedule" className="stat stat-link">
            <span>{upcoming.data.shifts[0] && Date.parse(upcoming.data.shifts[0].startsAt) <= now ? 'Current shift' : 'Next shift'}</span>
            {upcoming.data.shifts[0] ? (
              <strong className="stat-text">
                {dayKey(upcoming.data.shifts[0].startsAt, tz) === dayKey(new Date(), tz)
                  ? 'Today'
                  : formatDay(dayKey(upcoming.data.shifts[0].startsAt, tz))}
                , {time(upcoming.data.shifts[0].startsAt, tz)}–{time(upcoming.data.shifts[0].endsAt, tz)}
              </strong>
            ) : (
              <strong className="stat-text muted">Nothing scheduled</strong>
            )}
          </Link>
        )}
      </div>
    </section>
  );
}

export function SessionsTable({
  sessions,
  timeZone,
  canFix = false,
}: {
  sessions: WorkSession[];
  timeZone: string;
  canFix?: boolean;
}) {
  if (!sessions.length) return <p className="empty">No time recorded in this period.</p>;
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
            <th />
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
              <td className="row-actions">
                {s.pendingExceptionId ? (
                  <span className="badge">Correction pending</span>
                ) : (
                  <>
                    {s.source === 'correction' && <span className="badge edited">Edited</span>}
                    {canFix && <Link to={`/requests/new?session=${s.id}`}>Fix</Link>}
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
