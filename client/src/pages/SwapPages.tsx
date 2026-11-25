import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api, SWAP_STATUS_LABELS, SWAP_TYPE_LABELS, type Swap } from '../api.ts';
import { useMe } from '../auth.tsx';
import { time } from '../format.ts';
import { dayKey, formatDay } from '../tz.ts';
import { errorMessage, useApi } from '../useApi.ts';

export const SWAPS_CHANGED = 'synrgy:swaps-changed';

interface SwapLists {
  mine: Swap[];
  incoming: Swap[];
  available: Swap[];
  review: Swap[];
}

const name = (p: { firstName: string; lastName: string } | null) => (p ? `${p.firstName} ${p.lastName}` : '');

function ShiftLine({ shift, tz }: { shift: Swap['shift']; tz: string }) {
  return (
    <span>
      <strong>{formatDay(dayKey(shift.startsAt, tz))}</strong> · {time(shift.startsAt, tz)}–{time(shift.endsAt, tz)}
      {shift.position && <span className="muted"> · {shift.position}</span>}
    </span>
  );
}

function statusClass(s: Swap['status']) {
  if (s === 'approved') return 'status-approved';
  if (s === 'pending_peer' || s === 'pending_manager') return 'status-pending';
  if (s === 'cancelled') return 'status-cancelled';
  return 'status-rejected';
}

/** One swap request, described from the viewer's point of view. */
function SwapCard({ swap, tz, children, perspective }: { swap: Swap; tz: string; children?: ReactNode; perspective: 'mine' | 'incoming' | 'available' | 'review' }) {
  const headline = {
    mine:
      swap.type === 'open'
        ? 'You offered your shift'
        : swap.type === 'cover'
          ? `You asked ${name(swap.targetUser)} to cover`
          : `You proposed a swap with ${name(swap.targetUser)}`,
    incoming:
      swap.type === 'cover' ? `${name(swap.requester)} asked you to cover` : `${name(swap.requester)} wants to swap with you`,
    available: `${name(swap.requester)} is offering a shift`,
    review:
      swap.type === 'swap'
        ? `${name(swap.requester)} ⇄ ${name(swap.acceptedBy)}`
        : `${name(swap.requester)} → ${name(swap.acceptedBy)}`,
  }[perspective];

  return (
    <article className="card swap-card">
      <header>
        <div>
          <span className="eyebrow small">{SWAP_TYPE_LABELS[swap.type]}</span>
          <strong>{headline}</strong>
        </div>
        <span className={`badge ${statusClass(swap.status)}`}>{SWAP_STATUS_LABELS[swap.status]}</span>
      </header>
      <div className="swap-shifts">
        <div className="shift">
          <span className="shift-label">{perspective === 'mine' ? 'Your shift' : `${swap.requester.firstName}'s shift`}</span>
          <ShiftLine shift={swap.shift} tz={tz} />
        </div>
        {swap.targetShift && (
          <>
            <span className="arrow" aria-hidden="true">⇄</span>
            <div className="shift">
              <span className="shift-label">{perspective === 'incoming' ? 'Your shift' : `${swap.targetUser?.firstName}'s shift`}</span>
              <ShiftLine shift={swap.targetShift} tz={tz} />
            </div>
          </>
        )}
      </div>
      {swap.message && <p className="reason">“{swap.message}”</p>}
      {perspective === 'mine' && swap.acceptedBy && swap.type === 'open' && (
        <p className="small">Picked up by {name(swap.acceptedBy)}</p>
      )}
      {swap.reviewNote && (
        <p className="review-note small">
          {swap.reviewer ? <strong>{name(swap.reviewer)}: </strong> : null}
          {swap.reviewNote}
        </p>
      )}
      {children}
    </article>
  );
}

function useSwapAction(reload: () => Promise<void>) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (id: string, action: string, body?: unknown) => {
    setBusy(id);
    setErrors((e) => ({ ...e, [id]: '' }));
    try {
      await api.post(`/swaps/${id}/${action}`, body);
      await reload();
      window.dispatchEvent(new Event(SWAPS_CHANGED));
    } catch (err) {
      setErrors((e) => ({ ...e, [id]: errorMessage(err) }));
    } finally {
      setBusy(null);
    }
  };
  return { errors, busy, run };
}

export function SwapsPage() {
  const { organization } = useMe();
  const tz = organization.timezone;
  const { data, error, reload } = useApi(() => api.get<SwapLists>('/swaps'));
  const { errors, busy, run } = useSwapAction(reload);
  const err = (id: string) => errors[id] && <p className="error" role="alert">{errors[id]}</p>;

  return (
    <section>
      <div className="page-head">
        <div>
          <p className="eyebrow">Schedule</p>
          <h1>Shift swaps</h1>
        </div>
        <Link className="button" to="/schedule">
          Open schedule
        </Link>
      </div>
      <p className="muted">To trade one of your shifts, click it on the schedule.</p>
      {error && <p className="error" role="alert">{error}</p>}

      {data && (
        <>
          <h2>Asked of you {data.incoming.length > 0 && <span className="count-pill">{data.incoming.length}</span>}</h2>
          {data.incoming.length === 0 && <p className="empty">No one has asked you to swap or cover.</p>}
          <div className="card-list">
            {data.incoming.map((s) => (
              <SwapCard key={s.id} swap={s} tz={tz} perspective="incoming">
                <div className="card-actions">
                  <button className="secondary" disabled={busy === s.id} onClick={() => void run(s.id, 'decline')}>
                    Decline
                  </button>
                  <button disabled={busy === s.id} onClick={() => void run(s.id, 'accept')}>
                    Accept
                  </button>
                </div>
                {err(s.id)}
              </SwapCard>
            ))}
          </div>

          <h2>Up for grabs</h2>
          {data.available.length === 0 && <p className="empty">No open shifts on offer right now.</p>}
          <div className="card-list">
            {data.available.map((s) => (
              <SwapCard key={s.id} swap={s} tz={tz} perspective="available">
                <div className="card-actions">
                  <button disabled={busy === s.id} onClick={() => void run(s.id, 'accept')}>
                    Pick up this shift
                  </button>
                </div>
                {err(s.id)}
              </SwapCard>
            ))}
          </div>

          <h2>Your requests</h2>
          {data.mine.length === 0 && <p className="empty">You haven't asked to trade any shifts.</p>}
          <div className="card-list">
            {data.mine.map((s) => (
              <SwapCard key={s.id} swap={s} tz={tz} perspective="mine">
                {(s.status === 'pending_peer' || s.status === 'pending_manager') && (
                  <div className="card-actions">
                    <button className="secondary" disabled={busy === s.id} onClick={() => void run(s.id, 'cancel')}>
                      Cancel request
                    </button>
                  </div>
                )}
                {err(s.id)}
              </SwapCard>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** Manager queue, embedded in the Approvals page. */
export function SwapApprovals() {
  const { organization } = useMe();
  const tz = organization.timezone;
  const { data, error, reload } = useApi(() => api.get<SwapLists>('/swaps'));
  const { errors, busy, run } = useSwapAction(reload);
  const [notes, setNotes] = useState<Record<string, string>>({});

  return (
    <>
      {error && <p className="error" role="alert">{error}</p>}
      {data && data.review.length === 0 && <p className="empty">No swaps waiting for approval.</p>}
      <div className="card-list">
        {data?.review.map((s) => (
          <SwapCard key={s.id} swap={s} tz={tz} perspective="review">
            <div className="review-box">
              <input
                placeholder="Note (required to reject)"
                value={notes[s.id] ?? ''}
                onChange={(e) => setNotes((n) => ({ ...n, [s.id]: e.target.value }))}
              />
              <div className="card-actions">
                <button className="secondary" disabled={busy === s.id} onClick={() => void run(s.id, 'reject', { note: notes[s.id] })}>
                  Reject
                </button>
                <button disabled={busy === s.id} onClick={() => void run(s.id, 'approve', { note: notes[s.id] || undefined })}>
                  Approve
                </button>
              </div>
              {errors[s.id] && <p className="error" role="alert">{errors[s.id]}</p>}
            </div>
          </SwapCard>
        ))}
      </div>
    </>
  );
}
