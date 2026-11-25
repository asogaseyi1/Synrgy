import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  api,
  atLeast,
  ROLE_LABELS,
  type Announcement,
  type FeedAnnouncement,
  type ManagedAnnouncement,
  type OrgUnit,
  type Receipt,
  type Role,
  type User,
} from '../api.ts';
import { useMe } from '../auth.tsx';
import { date, time } from '../format.ts';
import { Modal } from '../Modal.tsx';
import { fromZonedInput, toZonedInput } from '../tz.ts';
import { errorMessage, useApi } from '../useApi.ts';

export const ANNOUNCEMENTS_CHANGED = 'synrgy:announcements-changed';
const changed = () => window.dispatchEvent(new Event(ANNOUNCEMENTS_CHANGED));

const ROLES: Role[] = ['employee', 'manager', 'admin', 'owner'];
const when = (iso: string, tz: string) => `${date(iso, tz)} · ${time(iso, tz)}`;
const name = (p: { firstName: string; lastName: string } | null) => (p ? `${p.firstName} ${p.lastName}` : 'Someone');

function audienceLabel(a: Announcement) {
  const roles = a.audienceRoles.length ? a.audienceRoles.map((r) => ROLE_LABELS[r]).join(', ') : null;
  const team = a.audienceTeam ? `${a.audienceTeam.firstName}'s team` : null;
  const units = [a.audienceDepartment?.name, a.audienceLocation?.name].filter(Boolean).join(' · ');
  const base = team && roles ? `${roles} on ${team}` : (team ?? roles ?? (units ? '' : 'Everyone'));
  return [base, units].filter(Boolean).join(' in ');
}

// ---------- Reader feed ----------

export function AnnouncementsPage() {
  const { user, organization } = useMe();
  const tz = organization.timezone;
  const [params, setParams] = useSearchParams();
  const archived = params.get('view') === 'archive';
  const { data, error, reload } = useApi(
    () => api.get<{ announcements: FeedAnnouncement[] }>(`/announcements${archived ? '?archived=1' : ''}`),
    [archived],
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [ackError, setAckError] = useState<string | null>(null);

  // Showing an announcement counts as reading it. "New" badges stay for this visit.
  useEffect(() => {
    const unread = data?.announcements.filter((a) => !a.readAt && !a.isAuthor).map((a) => a.id) ?? [];
    if (!unread.length) return;
    void api.post('/announcements/read', { ids: unread }).then(changed, () => undefined);
  }, [data]);

  const acknowledge = async (id: string) => {
    setBusy(id);
    setAckError(null);
    try {
      await api.post(`/announcements/${id}/acknowledge`);
      await reload();
      changed();
    } catch (err) {
      setAckError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="narrow-wide">
      <div className="page-head">
        <div>
          <p className="eyebrow">{organization.name}</p>
          <h1>Announcements</h1>
        </div>
        <div className="toolbar">
          <div className="tabs small-tabs" role="tablist">
            <button className={archived ? '' : 'active'} onClick={() => setParams({})}>
              Current
            </button>
            <button className={archived ? 'active' : ''} onClick={() => setParams({ view: 'archive' })}>
              Archive
            </button>
          </div>
          {atLeast(user.role, 'manager') && (
            <Link className="button" to="/announcements/manage">
              Manage
            </Link>
          )}
        </div>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {ackError && <p className="error" role="alert">{ackError}</p>}
      {data && data.announcements.length === 0 && (
        <p className="empty">{archived ? 'Nothing in the archive yet.' : "You're all caught up — no announcements right now."}</p>
      )}
      <div className="card-list">
        {data?.announcements.map((a) => {
          const needsAck = a.requiresAck && !a.acknowledgedAt && !a.isAuthor;
          return (
            <article key={a.id} className={`card announcement${a.pinned ? ' pinned' : ''}${needsAck ? ' needs-ack' : ''}`}>
              <header>
                <div>
                  <div className="ann-flags">
                    {a.pinned && <span className="badge pin">📌 Pinned</span>}
                    {!a.readAt && !a.isAuthor && <span className="badge new">New</span>}
                    {a.requiresAck && <span className="badge status-pending">Acknowledgement required</span>}
                    {a.editedAt && <span className="badge edited">Edited</span>}
                  </div>
                  <h2>{a.title}</h2>
                  <p className="muted small">
                    {name(a.author)} · {when(a.publishAt, tz)} · <span className="audience">{audienceLabel(a)}</span>
                  </p>
                </div>
              </header>
              <div className="ann-body">{a.body}</div>
              {a.requiresAck && !a.isAuthor && (
                <div className="ack-box">
                  {a.acknowledgedAt ? (
                    <span className="ack-done">✓ You acknowledged this on {when(a.acknowledgedAt, tz)}</span>
                  ) : (
                    <>
                      <span>Please confirm you've read and understood this.</span>
                      <button disabled={busy === a.id || archived} onClick={() => void acknowledge(a.id)}>
                        I acknowledge
                      </button>
                    </>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

// ---------- Author / admin view ----------

function pct(n: number, d: number) {
  return d ? Math.round((n / d) * 100) : 0;
}

function Meter({ label, n, d }: { label: string; n: number; d: number }) {
  const p = pct(n, d);
  return (
    <div className="meter">
      <div className="meter-label">
        <span>{label}</span>
        <strong>
          {p}% <span className="muted small">({n}/{d})</span>
        </strong>
      </div>
      <div className="meter-track" role="progressbar" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="meter-fill" style={{ width: `${p}%` }} />
      </div>
    </div>
  );
}

const STATE_CLASS = { scheduled: 'status-pending', live: 'status-approved', expired: 'status-cancelled' } as const;

export function ManageAnnouncementsPage() {
  const { organization } = useMe();
  const tz = organization.timezone;
  const { data, error, reload } = useApi(() => api.get<{ announcements: ManagedAnnouncement[] }>('/announcements/manage'));
  const [editing, setEditing] = useState<ManagedAnnouncement | 'new' | null>(null);
  const [receiptsFor, setReceiptsFor] = useState<ManagedAnnouncement | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const remove = async (a: ManagedAnnouncement) => {
    if (!confirm(`Delete “${a.title}”? This also removes its read receipts.`)) return;
    setActionError(null);
    try {
      await api.del(`/announcements/${a.id}`);
      await reload();
      changed();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  return (
    <section className="narrow-wide">
      <div className="page-head">
        <div>
          <p className="eyebrow">
            <Link to="/announcements">Announcements</Link> / Manage
          </p>
          <h1>Manage announcements</h1>
        </div>
        <button onClick={() => setEditing('new')}>New announcement</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {actionError && <p className="error" role="alert">{actionError}</p>}
      {data && data.announcements.length === 0 && <p className="empty">You haven't posted anything yet.</p>}
      <div className="card-list">
        {data?.announcements.map((a) => (
          <article key={a.id} className="card announcement">
            <header>
              <div>
                <div className="ann-flags">
                  <span className={`badge ${STATE_CLASS[a.state]}`}>{a.state}</span>
                  {a.pinned && <span className="badge pin">📌 Pinned</span>}
                  {a.requiresAck && <span className="badge edited">Needs acknowledgement</span>}
                </div>
                <h2>{a.title}</h2>
                <p className="muted small">
                  {a.state === 'scheduled' ? 'Goes out' : 'Posted'} {when(a.publishAt, tz)}
                  {a.expiresAt && <> · {a.state === 'expired' ? 'expired' : 'expires'} {when(a.expiresAt, tz)}</>} ·{' '}
                  <span className="audience">{audienceLabel(a)}</span> · by {name(a.author)}
                </p>
              </div>
            </header>
            <p className="ann-preview">{a.body}</p>
            {a.state !== 'scheduled' && (
              <div className="meters">
                <Meter label="Read" n={a.stats.read} d={a.stats.recipients} />
                {a.requiresAck && <Meter label="Acknowledged" n={a.stats.acknowledged} d={a.stats.recipients} />}
              </div>
            )}
            <div className="card-actions">
              <button className="link danger-link" onClick={() => void remove(a)}>
                Delete
              </button>
              <span className="spacer" />
              {a.state !== 'scheduled' && (
                <button className="secondary" onClick={() => setReceiptsFor(a)}>
                  Receipts
                </button>
              )}
              <button className="secondary" onClick={() => setEditing(a)}>
                Edit
              </button>
            </div>
          </article>
        ))}
      </div>

      {editing && (
        <AnnouncementEditor
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
            changed();
          }}
        />
      )}
      {receiptsFor && <ReceiptsDialog announcement={receiptsFor} onClose={() => setReceiptsFor(null)} />}
    </section>
  );
}

function AnnouncementEditor({
  existing,
  onClose,
  onSaved,
}: {
  existing: ManagedAnnouncement | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { user, organization } = useMe();
  const tz = organization.timezone;
  const isAdmin = atLeast(user.role, 'admin');
  const members = useApi(() => (isAdmin ? api.get<{ members: User[] }>('/members') : Promise.resolve({ members: [] as User[] })));
  const managers = members.data?.members.filter((m) => m.status === 'active' && m.role !== 'employee') ?? [];

  const [title, setTitle] = useState(existing?.title ?? '');
  const [body, setBody] = useState(existing?.body ?? '');
  const [team, setTeam] = useState(existing?.audienceTeam?.id ?? '');
  const [roles, setRoles] = useState<Role[]>(existing?.audienceRoles ?? []);
  const [departmentId, setDepartmentId] = useState(existing?.audienceDepartment?.id ?? '');
  const [locationId, setLocationId] = useState(existing?.audienceLocation?.id ?? '');
  const units = useApi(() => api.get<{ units: OrgUnit[] }>('/organization/units'));
  const departments = units.data?.units.filter((u) => u.kind === 'department') ?? [];
  const locations = units.data?.units.filter((u) => u.kind === 'location') ?? [];
  const [pinned, setPinned] = useState(existing?.pinned ?? false);
  const [requiresAck, setRequiresAck] = useState(existing?.requiresAck ?? false);
  const [schedule, setSchedule] = useState(existing?.state === 'scheduled');
  const [publishAt, setPublishAt] = useState(toZonedInput(existing?.publishAt ?? new Date(Date.now() + 3_600_000), tz));
  const [expires, setExpires] = useState(!!existing?.expiresAt);
  const [expiresAt, setExpiresAt] = useState(toZonedInput(existing?.expiresAt ?? new Date(Date.now() + 7 * 86_400_000), tz));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const wasPublished = existing && existing.state !== 'scheduled';
  const textChanged = existing && (title.trim() !== existing.title || body.trim() !== existing.body);

  const toggleRole = (r: Role) => setRoles((rs) => (rs.includes(r) ? rs.filter((x) => x !== r) : [...rs, r]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const payload: Record<string, unknown> = {
      title,
      body,
      audienceRoles: roles,
      audienceDepartmentId: departmentId || null,
      audienceLocationId: locationId || null,
      pinned,
      requiresAck,
      expiresAt: expires ? fromZonedInput(expiresAt, tz) : null,
    };
    if (isAdmin) payload.audienceTeamOf = team || null;
    // Only touch publish time when scheduling, or when bringing a scheduled post forward to "now".
    if (schedule) payload.publishAt = fromZonedInput(publishAt, tz);
    else if (!existing || existing.state === 'scheduled') payload.publishAt = null;
    try {
      if (existing) await api.patch(`/announcements/${existing.id}`, payload);
      else await api.post('/announcements', payload);
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  };

  return (
    <Modal title={existing ? 'Edit announcement' : 'New announcement'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label>
          Title
          <input value={title} maxLength={200} required onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          Message
          <textarea rows={7} value={body} maxLength={20000} required onChange={(e) => setBody(e.target.value)} />
        </label>

        <fieldset>
          <legend>Audience</legend>
          {isAdmin ? (
            <label>
              Who
              <select value={team} onChange={(e) => setTeam(e.target.value)}>
                <option value="">Whole organization</option>
                {managers.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.firstName} {m.lastName}'s team
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="muted small flush">Goes to you and your direct reports.</p>
          )}
          {(departments.length > 0 || locations.length > 0) && (
            <div className="row">
              {departments.length > 0 && (
                <label>
                  Department
                  <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                    <option value="">Any department</option>
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {locations.length > 0 && (
                <label>
                  Location
                  <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                    <option value="">Any location</option>
                    {locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}
          <div className="role-picks">
            {ROLES.map((r) => (
              <label key={r} className={`pick${roles.includes(r) ? ' selected' : ''}`}>
                <input type="checkbox" checked={roles.includes(r)} onChange={() => toggleRole(r)} />
                {ROLE_LABELS[r]}
              </label>
            ))}
          </div>
          <p className="muted small flush">{roles.length ? 'Only the selected roles will see it.' : 'All roles (select some to narrow it down).'}</p>
        </fieldset>

        <label className="check">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
          <span>
            Pin to the top
            <span className="muted small">Pinned posts stay above newer ones.</span>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={requiresAck} onChange={(e) => setRequiresAck(e.target.checked)} />
          <span>
            Require acknowledgement
            <span className="muted small">For policy updates — everyone must confirm they've read it.</span>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={schedule} onChange={(e) => setSchedule(e.target.checked)} />
          <span>{wasPublished ? 'Change publish time' : 'Schedule for later'}</span>
        </label>
        {schedule && <input type="datetime-local" value={publishAt} onChange={(e) => setPublishAt(e.target.value)} required />}
        <label className="check">
          <input type="checkbox" checked={expires} onChange={(e) => setExpires(e.target.checked)} />
          <span>
            Expire automatically
            <span className="muted small">After this it moves to the archive.</span>
          </span>
        </label>
        {expires && <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} required />}
        <p className="muted small flush">Times are in {tz.replace(/_/g, ' ')}.</p>

        {wasPublished && textChanged && existing.requiresAck && (
          <p className="banner small">Changing the text will reset everyone's acknowledgement — they'll be asked to confirm again.</p>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="card-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button disabled={saving}>{existing ? 'Save changes' : schedule ? 'Schedule' : 'Post now'}</button>
        </div>
      </form>
    </Modal>
  );
}

function ReceiptsDialog({ announcement, onClose }: { announcement: ManagedAnnouncement; onClose: () => void }) {
  const tz = useMe().organization.timezone;
  const { data, error } = useApi(() => api.get<{ receipts: Receipt[] }>(`/announcements/${announcement.id}/receipts`));
  const [filter, setFilter] = useState<'all' | 'pending'>('all');
  const pending = (r: Receipt) => (announcement.requiresAck ? !r.acknowledgedAt : !r.readAt);
  const rows = data?.receipts.filter((r) => filter === 'all' || pending(r)) ?? [];

  return (
    <Modal title={`Receipts · ${announcement.title}`} onClose={onClose}>
      <div className="tabs small-tabs">
        <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
          Everyone
        </button>
        <button className={filter === 'pending' ? 'active' : ''} onClick={() => setFilter('pending')}>
          {announcement.requiresAck ? 'Not acknowledged' : 'Unread'}
          {data && <span className="count">{data.receipts.filter(pending).length}</span>}
        </button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {data && rows.length === 0 && <p className="empty">{filter === 'pending' ? 'Everyone is done. 🎉' : 'No recipients.'}</p>}
      {rows.length > 0 && (
        <table className="receipts">
          <thead>
            <tr>
              <th>Person</th>
              <th>Read</th>
              {announcement.requiresAck && <th>Acknowledged</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.firstName} {r.lastName} <span className="muted small">· {r.role}</span>
                </td>
                <td className={r.readAt ? '' : 'muted'}>{r.readAt ? when(r.readAt, tz) : '—'}</td>
                {announcement.requiresAck && (
                  <td className={r.acknowledgedAt ? 'ack-done' : 'muted'}>{r.acknowledgedAt ? when(r.acknowledgedAt, tz) : '—'}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
