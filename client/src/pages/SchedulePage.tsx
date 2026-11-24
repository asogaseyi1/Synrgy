import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api, atLeast, type Shift, type SwapType, type User } from '../api.ts';
import { useMe } from '../auth.tsx';
import { duration, time } from '../format.ts';
import { Modal } from '../Modal.tsx';
import { addDays, dayKey, formatDay, fromZonedInput, mondayOf, startOfDay, toZonedInput } from '../tz.ts';
import { errorMessage, useApi } from '../useApi.ts';

const OPEN_ROW = '__open__';

export function SchedulePage() {
  const { user: me, organization } = useMe();
  const tz = organization.timezone;
  const isManager = atLeast(me.role, 'manager');
  const today = dayKey(new Date(), tz);

  const [weekStart, setWeekStart] = useState(() => mondayOf(today));
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const from = startOfDay(weekStart, tz);
  const to = startOfDay(addDays(weekStart, 7), tz);

  const shifts = useApi(
    () => api.get<{ shifts: Shift[] }>(`/shifts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    [from, to],
  );
  const members = useApi(
    () => (isManager ? api.get<{ members: User[] }>('/members') : Promise.resolve({ members: [] as User[] })),
    [isManager],
  );

  const [editing, setEditing] = useState<{ shift?: Shift; day: string; userId: string | null } | null>(null);
  const [swapping, setSwapping] = useState<Shift | null>(null);
  const [publishMsg, setPublishMsg] = useState<string | null>(null);

  // Who a manager may schedule: admins → everyone active; managers → self + direct reports.
  const schedulable = useMemo(() => {
    if (!isManager || !members.data) return [];
    return members.data.members.filter(
      (m) => m.status === 'active' && (atLeast(me.role, 'admin') || m.id === me.id || m.managerId === me.id),
    );
  }, [isManager, members.data, me]);

  // Rows: open shifts, then people (me first). Managers also get empty rows for people they can schedule.
  const rows = useMemo(() => {
    const people = new Map<string, { id: string; name: string }>();
    for (const m of schedulable) people.set(m.id, { id: m.id, name: `${m.firstName} ${m.lastName}` });
    for (const s of shifts.data?.shifts ?? []) {
      if (s.user) people.set(s.user.id, { id: s.user.id, name: `${s.user.firstName} ${s.user.lastName}` });
    }
    const list = [...people.values()].sort((a, b) =>
      a.id === me.id ? -1 : b.id === me.id ? 1 : a.name.localeCompare(b.name),
    );
    const hasOpen = isManager || shifts.data?.shifts.some((s) => !s.user);
    return hasOpen ? [{ id: OPEN_ROW, name: 'Open shifts' }, ...list] : list;
  }, [schedulable, shifts.data, me.id, isManager]);

  const cell = (rowId: string, day: string) =>
    (shifts.data?.shifts ?? []).filter(
      (s) => (rowId === OPEN_ROW ? !s.user : s.user?.id === rowId) && dayKey(s.startsAt, tz) === day,
    );

  const drafts = shifts.data?.shifts.filter((s) => s.isDraft).length ?? 0;
  const myHours =
    (shifts.data?.shifts ?? [])
      .filter((s) => s.user?.id === me.id)
      .reduce((t, s) => t + (Date.parse(s.endsAt) - Date.parse(s.startsAt)), 0) / 1000;

  const publish = async () => {
    const res = await api.post<{ published: number }>('/shifts/publish', { from, to });
    setPublishMsg(`Published ${res.published} shift${res.published === 1 ? '' : 's'}.`);
    await shifts.reload();
  };

  const canSchedule = (rowId: string) => isManager && (rowId === OPEN_ROW || schedulable.some((m) => m.id === rowId));
  const onChipClick = (s: Shift) => {
    if (isManager && canSchedule(s.user?.id ?? OPEN_ROW)) setEditing({ shift: s, day: dayKey(s.startsAt, tz), userId: s.user?.id ?? null });
    else if (s.user?.id === me.id && !s.isDraft && Date.parse(s.startsAt) > Date.now()) setSwapping(s);
  };

  return (
    <section className="wide">
      <div className="page-head">
        <div>
          <p className="eyebrow">Schedule</p>
          <h1>
            {formatDay(days[0], { month: 'short', day: 'numeric' })} – {formatDay(days[6], { month: 'short', day: 'numeric', year: 'numeric' })}
          </h1>
        </div>
        <div className="toolbar">
          <div className="tabs">
            <button aria-label="Previous week" onClick={() => setWeekStart(addDays(weekStart, -7))}>‹</button>
            <button className={weekStart === mondayOf(today) ? 'active' : ''} onClick={() => setWeekStart(mondayOf(today))}>
              This week
            </button>
            <button aria-label="Next week" onClick={() => setWeekStart(addDays(weekStart, 7))}>›</button>
          </div>
          {isManager && (
            <>
              <button className="secondary" onClick={() => setEditing({ day: days[0] < today ? today : days[0], userId: null })}>
                + Add shift
              </button>
              <button disabled={!drafts} onClick={() => void publish()}>
                Publish{drafts ? ` ${drafts} draft${drafts === 1 ? '' : 's'}` : 'ed'}
              </button>
            </>
          )}
        </div>
      </div>

      <p className="muted">
        {isManager
          ? 'Click an empty slot to add a shift, or a shift to edit it. Drafts (dashed) are only visible to managers until published.'
          : <>You're scheduled for <strong>{duration(myHours)}</strong> this week. Click one of your upcoming shifts to swap it or ask for cover. See <Link to="/swaps">Swaps</Link> for requests.</>}
      </p>
      {publishMsg && <p className="notice">{publishMsg}</p>}
      {(shifts.error || members.error) && <p className="error">{shifts.error ?? members.error}</p>}

      <div className="schedule-wrap">
        <table className="schedule">
          <thead>
            <tr>
              <th className="person-col">Team</th>
              {days.map((d) => (
                <th key={d} className={d === today ? 'today' : undefined}>
                  {formatDay(d, { weekday: 'short' })}
                  <span>{formatDay(d, { day: 'numeric' })}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="muted center">No shifts published for this week.</td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className={row.id === me.id ? 'me' : row.id === OPEN_ROW ? 'open-row' : undefined}>
                <th className="person-col">{row.id === me.id ? `${row.name} (you)` : row.name}</th>
                {days.map((d) => {
                  const items = cell(row.id, d);
                  return (
                    <td key={d} className={d === today ? 'today' : undefined}>
                      {items.map((s) => (
                        <button
                          key={s.id}
                          className={`chip${s.isDraft ? ' draft' : ''}${s.user?.id === me.id ? ' mine' : ''}`}
                          onClick={() => onChipClick(s)}
                          title={[s.position, s.location, s.notes].filter(Boolean).join(' · ')}
                        >
                          <span className="chip-time">
                            {time(s.startsAt, tz)}–{time(s.endsAt, tz)}
                          </span>
                          {s.position && <span className="chip-pos">{s.position}</span>}
                          {s.activeSwap && <span className="chip-flag" title="Swap pending">⇄</span>}
                        </button>
                      ))}
                      {canSchedule(row.id) && d >= today && (
                        <button
                          className="add-slot"
                          aria-label={`Add shift for ${row.name} on ${formatDay(d)}`}
                          onClick={() => setEditing({ day: d, userId: row.id === OPEN_ROW ? null : row.id })}
                        >
                          +
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <ShiftEditor
          {...editing}
          people={schedulable}
          tz={tz}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setPublishMsg(null);
            void shifts.reload();
          }}
        />
      )}
      {swapping && (
        <SwapRequestDialog
          shift={swapping}
          tz={tz}
          onClose={() => setSwapping(null)}
          onDone={() => {
            setSwapping(null);
            void shifts.reload();
          }}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

function ShiftEditor({
  shift,
  day,
  userId,
  people,
  tz,
  onClose,
  onSaved,
}: {
  shift?: Shift;
  day: string;
  userId: string | null;
  people: User[];
  tz: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [date, setDate] = useState(shift ? dayKey(shift.startsAt, tz) : day);
  const [start, setStart] = useState(shift ? toZonedInput(shift.startsAt, tz).slice(11) : '09:00');
  const [end, setEnd] = useState(shift ? toZonedInput(shift.endsAt, tz).slice(11) : '17:00');
  const [assignee, setAssignee] = useState(shift?.user?.id ?? userId ?? '');
  const [position, setPosition] = useState(shift?.position ?? '');
  const [location, setLocation] = useState(shift?.location ?? '');
  const [notes, setNotes] = useState(shift?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const overnight = end <= start;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      userId: assignee || null,
      startsAt: fromZonedInput(`${date}T${start}`, tz),
      endsAt: fromZonedInput(`${overnight ? addDays(date, 1) : date}T${end}`, tz),
      position,
      location,
      notes,
    };
    try {
      if (shift) await api.patch(`/shifts/${shift.id}`, body);
      else await api.post('/shifts', body);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!shift || !confirm('Delete this shift?')) return;
    try {
      await api.del(`/shifts/${shift.id}`);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Modal title={shift ? 'Edit shift' : 'New shift'} onClose={onClose}>
      <form onSubmit={save}>
        <label>
          Assigned to
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Open shift (unassigned)</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.firstName} {p.lastName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Date
          <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <div className="row">
          <label>
            Starts
            <input type="time" required value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label>
            Ends {overnight && <span className="muted">(next day)</span>}
            <input type="time" required value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
        </div>
        <div className="row">
          <label>
            Position
            <input value={position} maxLength={80} placeholder="e.g. Cashier" onChange={(e) => setPosition(e.target.value)} />
          </label>
          <label>
            Location
            <input value={location} maxLength={120} placeholder="e.g. Downtown" onChange={(e) => setLocation(e.target.value)} />
          </label>
        </div>
        <label>
          Notes
          <input value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
        </label>
        {shift?.activeSwap && <p className="notice small">Saving will cancel the pending swap request on this shift.</p>}
        {error && <p className="error">{error}</p>}
        <div className="card-actions">
          {shift && (
            <button type="button" className="link danger-link" onClick={() => void remove()}>
              Delete
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button disabled={busy}>{shift ? 'Save' : 'Add shift'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function SwapRequestDialog({ shift, tz, onClose, onDone }: { shift: Shift; tz: string; onClose: () => void; onDone: () => void }) {
  const { user: me } = useMe();
  const [type, setType] = useState<SwapType>('open');
  const [targetUserId, setTargetUserId] = useState('');
  const [targetShiftId, setTargetShiftId] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Coworkers' upcoming published shifts over the next 4 weeks: candidates for a swap, and a list of people for cover.
  const candidates = useApi(() => {
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 28 * 86_400_000).toISOString();
    return api.get<{ shifts: Shift[] }>(`/shifts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  });
  const theirShifts = (candidates.data?.shifts ?? []).filter(
    (s) => s.user && s.user.id !== me.id && !s.isDraft && !s.activeSwap && Date.parse(s.startsAt) > Date.now(),
  );
  const coworkers = [...new Map(theirShifts.map((s) => [s.user!.id, s.user!])).values()].sort((a, b) =>
    a.firstName.localeCompare(b.firstName),
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/swaps', {
        shiftId: shift.id,
        type,
        targetUserId: type === 'cover' ? targetUserId : undefined,
        targetShiftId: type === 'swap' ? targetShiftId : undefined,
        message: message || undefined,
      });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const label = `${formatDay(dayKey(shift.startsAt, tz))}, ${time(shift.startsAt, tz)}–${time(shift.endsAt, tz)}`;

  if (shift.activeSwap) {
    return (
      <Modal title="Swap pending" onClose={onClose}>
        <p>
          This shift ({label}) already has a swap request in progress. Manage it from <Link to="/swaps">Swaps</Link>.
        </p>
      </Modal>
    );
  }

  return (
    <Modal title="Trade this shift" onClose={onClose}>
      <p className="muted">{label}{shift.position ? ` · ${shift.position}` : ''}</p>
      <form onSubmit={submit}>
        <div className="choice-group" role="radiogroup">
          {(
            [
              ['open', 'Offer it to anyone', 'Any coworker can pick it up.'],
              ['cover', 'Ask someone to cover', 'One person takes your shift.'],
              ['swap', 'Swap for their shift', 'You take one of theirs in return.'],
            ] as const
          ).map(([value, title, hint]) => (
            <label key={value} className={`choice${type === value ? ' selected' : ''}`}>
              <input type="radio" name="type" value={value} checked={type === value} onChange={() => setType(value)} />
              <span>
                <strong>{title}</strong>
                <span className="muted small">{hint}</span>
              </span>
            </label>
          ))}
        </div>

        {type === 'cover' && (
          <label>
            Who should cover?
            <select required value={targetUserId} onChange={(e) => setTargetUserId(e.target.value)}>
              <option value="">Choose a coworker…</option>
              {coworkers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.firstName} {c.lastName}
                </option>
              ))}
            </select>
            {!coworkers.length && <span className="muted small">No coworkers with published shifts in the next 4 weeks.</span>}
          </label>
        )}
        {type === 'swap' && (
          <label>
            Which shift do you want instead?
            <select required value={targetShiftId} onChange={(e) => setTargetShiftId(e.target.value)}>
              <option value="">Choose a shift…</option>
              {theirShifts.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.user!.firstName} · {formatDay(dayKey(s.startsAt, tz))} {time(s.startsAt, tz)}–{time(s.endsAt, tz)}
                  {s.position ? ` · ${s.position}` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Message <span className="muted">(optional)</span>
          <input value={message} maxLength={500} placeholder="e.g. Family event that evening" onChange={(e) => setMessage(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="card-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button disabled={busy}>Send request</button>
        </div>
      </form>
    </Modal>
  );
}
