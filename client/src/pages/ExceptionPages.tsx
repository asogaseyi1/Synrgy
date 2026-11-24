import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  api,
  EXCEPTION_KIND_LABELS,
  type ExceptionKind,
  type ExceptionStatus,
  type PunchException,
  type ShiftShape,
  type WorkSession,
} from '../api.ts';
import { useMe } from '../auth.tsx';
import { date, duration, time } from '../format.ts';
import { fromZonedInput, toZonedInput } from '../tz.ts';
import { errorMessage, useApi } from '../useApi.ts';

const MAX_AGE_DAYS = 31;

// ---------------------------------------------------------------------------
// Shared bits

function StatusBadge({ status }: { status: ExceptionStatus }) {
  return <span className={`badge status-${status}`}>{status}</span>;
}

function shiftSeconds(s: ShiftShape) {
  if (!s.clockOutAt) return null;
  const total = (Date.parse(s.clockOutAt) - Date.parse(s.clockInAt)) / 1000;
  const unpaid = s.breaks
    .filter((b) => b.kind === 'unpaid' && b.endedAt)
    .reduce((t, b) => t + (Date.parse(b.endedAt!) - Date.parse(b.startedAt)) / 1000, 0);
  return total - unpaid;
}

function ShiftSummary({ shift, tz, label }: { shift: ShiftShape | null; tz: string; label: string }) {
  if (!shift) {
    return (
      <div className="shift">
        <span className="shift-label">{label}</span>
        <span className="muted">Nothing recorded</span>
      </div>
    );
  }
  const worked = shiftSeconds(shift);
  return (
    <div className="shift">
      <span className="shift-label">{label}</span>
      <strong>{date(shift.clockInAt, tz)}</strong>
      <span>
        {time(shift.clockInAt, tz)} – {shift.clockOutAt ? time(shift.clockOutAt, tz) : <em>no clock-out</em>}
      </span>
      <span className="muted small">
        {shift.breaks.length === 0
          ? 'No breaks'
          : shift.breaks
              .map((b) => `${time(b.startedAt, tz)}–${b.endedAt ? time(b.endedAt, tz) : '?'} ${b.kind}`)
              .join(', ')}
      </span>
      {worked !== null && <span className="small">Worked {duration(worked)}</span>}
    </div>
  );
}

function ExceptionCard({
  ex,
  tz,
  showEmployee,
  children,
}: {
  ex: PunchException;
  tz: string;
  showEmployee?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <article className="card request-card">
      <header>
        <div>
          <strong>{EXCEPTION_KIND_LABELS[ex.kind]}</strong>
          {showEmployee && (
            <span className="muted">
              {' '}
              · {ex.user.firstName} {ex.user.lastName}
            </span>
          )}
          <div className="muted small">Filed {new Date(ex.createdAt).toLocaleString([], { timeZone: tz })}</div>
        </div>
        <StatusBadge status={ex.status} />
      </header>
      <div className="diff">
        <ShiftSummary shift={ex.original} tz={tz} label="Recorded" />
        <span className="arrow" aria-hidden="true">→</span>
        <ShiftSummary shift={ex.requested} tz={tz} label="Requested" />
      </div>
      <p className="reason">“{ex.reason}”</p>
      {ex.reviewer && (
        <p className="review-note small">
          <strong>
            {ex.status === 'approved' ? 'Approved' : 'Rejected'} by {ex.reviewer.firstName} {ex.reviewer.lastName}
          </strong>
          {ex.reviewNote && <>: {ex.reviewNote}</>}
        </p>
      )}
      {children}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Employee: my requests

export function MyRequestsPage() {
  const { organization } = useMe();
  const { data, error, reload } = useApi(() => api.get<{ exceptions: PunchException[] }>('/exceptions?scope=mine'));
  const [actionError, setActionError] = useState<string | null>(null);

  const cancel = async (id: string) => {
    setActionError(null);
    try {
      await api.post(`/exceptions/${id}/cancel`);
      await reload();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  return (
    <section>
      <div className="page-head">
        <div>
          <p className="eyebrow">Time corrections</p>
          <h1>My requests</h1>
        </div>
        <Link className="button" to="/requests/new">
          Report a missed shift
        </Link>
      </div>
      <p className="muted">
        To fix a shift that's already on your timesheet, use <Link to="/timesheet">Fix</Link> next to it.
      </p>
      {(error || actionError) && <p className="error">{error ?? actionError}</p>}
      {data && !data.exceptions.length && <p className="empty">You haven't filed any corrections.</p>}
      <div className="card-list">
        {data?.exceptions.map((ex) => (
          <ExceptionCard key={ex.id} ex={ex} tz={organization.timezone}>
            {ex.status === 'pending' && (
              <div className="card-actions">
                <button className="secondary" onClick={() => void cancel(ex.id)}>
                  Cancel request
                </button>
              </div>
            )}
          </ExceptionCard>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Employee: new request

interface BreakRow {
  key: number;
  startedAt: string;
  endedAt: string;
  kind: 'paid' | 'unpaid';
}

const SESSION_KINDS: ExceptionKind[] = ['missed_clock_out', 'missed_clock_in', 'missed_break', 'wrong_time'];

/** Remount the form when the query string changes (e.g. Fix → Report missed shift). */
export function NewRequestPage() {
  const [params] = useSearchParams();
  return <NewRequestForm key={params.toString()} />;
}

function NewRequestForm() {
  const { organization } = useMe();
  const tz = organization.timezone;
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const sessionId = params.get('session');

  const [session, setSession] = useState<WorkSession | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [kind, setKind] = useState<ExceptionKind>((params.get('kind') as ExceptionKind) ?? (sessionId ? 'wrong_time' : 'missed_shift'));
  const [clockIn, setClockIn] = useState('');
  const [clockOut, setClockOut] = useState('');
  const [breaks, setBreaks] = useState<BreakRow[]>([]);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Prefill from the session being corrected.
  useEffect(() => {
    if (!sessionId) return;
    const from = new Date(Date.now() - (MAX_AGE_DAYS + 1) * 86_400_000).toISOString();
    api
      .get<{ sessions: WorkSession[] }>(`/time/sessions?from=${encodeURIComponent(from)}`)
      .then(({ sessions }) => {
        const s = sessions.find((x) => x.id === sessionId);
        if (!s) return setLoadError('That shift is too old to correct or does not exist.');
        setSession(s);
        setClockIn(toZonedInput(s.clockInAt, tz));
        setClockOut(toZonedInput(s.clockOutAt, tz));
        setBreaks(
          s.breaks.map((b, i) => ({
            key: i,
            startedAt: toZonedInput(b.startedAt, tz),
            endedAt: toZonedInput(b.endedAt, tz),
            kind: b.kind,
          })),
        );
      })
      .catch((err) => setLoadError(errorMessage(err)));
  }, [sessionId, tz]);

  const updateBreak = (key: number, patch: Partial<BreakRow>) =>
    setBreaks((bs) => bs.map((b) => (b.key === key ? { ...b, ...patch } : b)));
  const addBreak = () =>
    setBreaks((bs) => [...bs, { key: Date.now(), startedAt: clockIn, endedAt: '', kind: 'unpaid' }]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (breaks.some((b) => !b.startedAt || !b.endedAt)) return setError('Fill in both times for every break, or remove it.');
    setBusy(true);
    try {
      await api.post('/exceptions', {
        kind: sessionId ? kind : 'missed_shift',
        workSessionId: sessionId ?? undefined,
        clockInAt: fromZonedInput(clockIn, tz),
        clockOutAt: fromZonedInput(clockOut, tz),
        breaks: breaks.map((b) => ({
          startedAt: fromZonedInput(b.startedAt, tz),
          endedAt: fromZonedInput(b.endedAt, tz),
          kind: b.kind,
        })),
        reason,
      });
      navigate('/requests');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (loadError) return <p className="error">{loadError}</p>;
  if (sessionId && !session) return <p className="loading">Loading…</p>;

  const maxInput = toZonedInput(new Date(), tz);
  const minInput = toZonedInput(new Date(Date.now() - MAX_AGE_DAYS * 86_400_000), tz);

  return (
    <section className="narrow">
      <p className="eyebrow">Time correction</p>
      <h1>{sessionId ? 'Fix a shift' : 'Report a missed shift'}</h1>
      <p className="muted">
        Enter the times as they actually happened. Your manager will review the request. Times are in{' '}
        <strong>{tz.replace(/_/g, ' ')}</strong>.
      </p>

      {session && (
        <div className="card">
          <ShiftSummary
            tz={tz}
            label="Currently recorded"
            shift={{ clockInAt: session.clockInAt, clockOutAt: session.clockOutAt, breaks: session.breaks }}
          />
        </div>
      )}

      <form className="card" onSubmit={submit}>
        {sessionId && (
          <label>
            What went wrong?
            <select value={kind} onChange={(e) => setKind(e.target.value as ExceptionKind)}>
              {SESSION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {EXCEPTION_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="row">
          <label>
            Clock in
            <input type="datetime-local" required min={minInput} max={maxInput} value={clockIn} onChange={(e) => setClockIn(e.target.value)} />
          </label>
          <label>
            Clock out
            <input type="datetime-local" required min={clockIn || minInput} max={maxInput} value={clockOut} onChange={(e) => setClockOut(e.target.value)} />
          </label>
        </div>

        <fieldset>
          <legend>Breaks</legend>
          {breaks.length === 0 && <p className="muted small">No breaks.</p>}
          {breaks.map((b) => (
            <div className="break-row" key={b.key}>
              <input type="datetime-local" aria-label="Break start" value={b.startedAt} min={clockIn} max={clockOut || maxInput} onChange={(e) => updateBreak(b.key, { startedAt: e.target.value })} />
              <span className="muted">to</span>
              <input type="datetime-local" aria-label="Break end" value={b.endedAt} min={b.startedAt || clockIn} max={clockOut || maxInput} onChange={(e) => updateBreak(b.key, { endedAt: e.target.value })} />
              <select aria-label="Break type" value={b.kind} onChange={(e) => updateBreak(b.key, { kind: e.target.value as 'paid' | 'unpaid' })}>
                <option value="unpaid">unpaid</option>
                <option value="paid">paid</option>
              </select>
              <button type="button" className="link" onClick={() => setBreaks((bs) => bs.filter((x) => x.key !== b.key))}>
                Remove
              </button>
            </div>
          ))}
          <button type="button" className="secondary small-btn" onClick={addBreak} disabled={!clockIn}>
            + Add break
          </button>
        </fieldset>

        <label>
          Reason
          <textarea
            required
            minLength={3}
            maxLength={1000}
            rows={3}
            placeholder="e.g. My phone died and I couldn't clock out."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="card-actions">
          <Link to={sessionId ? '/timesheet' : '/requests'}>Cancel</Link>
          <button disabled={busy}>Submit for approval</button>
        </div>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Manager: approvals

export const APPROVALS_CHANGED = 'synrgy:approvals-changed';

/** Time-correction queue, embedded in the Approvals page. */
export function ExceptionApprovals() {
  const { organization } = useMe();
  const [tab, setTab] = useState<'pending' | 'all'>('pending');
  const { data, error, reload } = useApi(
    () => api.get<{ exceptions: PunchException[] }>(`/exceptions?scope=review&status=${tab}`),
    [tab],
  );
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const decide = async (id: string, decision: 'approve' | 'reject') => {
    setBusyId(id);
    setCardErrors((e) => ({ ...e, [id]: '' }));
    try {
      await api.post(`/exceptions/${id}/${decision}`, { note: notes[id]?.trim() || undefined });
      await reload();
      window.dispatchEvent(new Event(APPROVALS_CHANGED));
    } catch (err) {
      setCardErrors((e) => ({ ...e, [id]: errorMessage(err) }));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div className="subhead">
        <div className="tabs small-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'pending'} className={tab === 'pending' ? 'active' : ''} onClick={() => setTab('pending')}>
            Pending
          </button>
          <button role="tab" aria-selected={tab === 'all'} className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>
            History
          </button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {data && !data.exceptions.length && (
        <p className="empty">{tab === 'pending' ? 'All caught up — nothing waiting for review.' : 'No requests yet.'}</p>
      )}
      <div className="card-list">
        {data?.exceptions.map((ex) => (
          <ExceptionCard key={ex.id} ex={ex} tz={organization.timezone} showEmployee>
            {ex.status === 'pending' && (
              <div className="review-box">
                <input
                  placeholder="Note to employee (required to reject)"
                  value={notes[ex.id] ?? ''}
                  onChange={(e) => setNotes((n) => ({ ...n, [ex.id]: e.target.value }))}
                />
                <div className="card-actions">
                  <button className="secondary" disabled={busyId === ex.id} onClick={() => void decide(ex.id, 'reject')}>
                    Reject
                  </button>
                  <button disabled={busyId === ex.id} onClick={() => void decide(ex.id, 'approve')}>
                    Approve
                  </button>
                </div>
                {cardErrors[ex.id] && <p className="error">{cardErrors[ex.id]}</p>}
              </div>
            )}
          </ExceptionCard>
        ))}
      </div>
    </>
  );
}
