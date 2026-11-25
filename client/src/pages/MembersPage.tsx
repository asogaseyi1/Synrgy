import { useState, type FormEvent } from 'react';
import { api, atLeast, type OrgUnit, type Role, type User } from '../api.ts';
import { useMe } from '../auth.tsx';
import { errorMessage, useApi } from '../useApi.ts';

interface Invitation {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
}

export function MembersPage() {
  const me = useMe().user;
  const members = useApi(() => api.get<{ members: User[] }>('/members'));
  const invites = useApi(() => api.get<{ invitations: Invitation[] }>('/members/invitations'));
  const [error, setError] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<{ url: string; emailed: boolean } | null>(null);
  const units = useApi(() => api.get<{ units: OrgUnit[] }>('/organization/units'));
  const departments = units.data?.units.filter((u) => u.kind === 'department') ?? [];
  const locations = units.data?.units.filter((u) => u.kind === 'location') ?? [];

  const managers = members.data?.members.filter((m) => atLeast(m.role, 'manager') && m.status === 'active') ?? [];
  const assignableRoles: Role[] = me.role === 'owner' ? ['admin', 'manager', 'employee'] : ['manager', 'employee'];

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await Promise.all([members.reload(), invites.reload()]);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const invite = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    void run(async () => {
      const res = await api.post<{ acceptUrl: string; emailed: boolean }>('/members/invitations', values);
      // Point the link at wherever this UI is actually served.
      setInviteLink({ url: res.acceptUrl.replace(/^https?:\/\/[^/]+/, window.location.origin), emailed: res.emailed });
      form.reset();
    });
  };

  const update = (id: string, patch: Partial<User>) => run(() => api.patch(`/members/${id}`, patch));
  const canEdit = (m: User) => m.id !== me.id && m.role !== 'owner' && (me.role === 'owner' || m.role !== 'admin');
  // The owner may also set their own manager / reviewer flag.
  const canEditFlags = (m: User) => canEdit(m) || (me.role === 'owner' && m.id === me.id);

  return (
    <section>
      <h1>People</h1>
      {units.data && units.data.units.length === 0 && (
        <p className="muted small">Tip: add departments and locations in Settings to group people, filter payroll and target announcements.</p>
      )}

      <form className="inline-form" onSubmit={invite}>
        <input name="email" type="email" placeholder="name@company.com" required />
        <select name="role" defaultValue="employee">
          {assignableRoles.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
        <button>Invite</button>
      </form>
      {inviteLink && (
        <p className="notice">
          {inviteLink.emailed ? 'Invitation emailed. You can also share the link directly: ' : "Email isn't set up, so share this invite link: "}
          <code>{inviteLink.url}</code>
        </p>
      )}
      {error && <p className="error" role="alert">{error}</p>}

      {!!invites.data?.invitations.length && (
        <>
          <h2>Pending invitations</h2>
          <ul className="plain">
            {invites.data.invitations.map((i) => (
              <li key={i.id}>
                {i.email} · {i.role}{' '}
                <button className="link" onClick={() => run(() => api.del(`/members/invitations/${i.id}`))}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>Members</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Manager</th>
              {departments.length > 0 && <th>Department</th>}
              {locations.length > 0 && <th>Location</th>}
              <th title="Can read anonymous reports">Report reviewer</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {members.data?.members.map((m) => (
              <tr key={m.id} className={m.status === 'deactivated' ? 'inactive' : undefined}>
                <td>
                  {m.firstName} {m.lastName}
                  <div className="muted small">{m.email}</div>
                </td>
                <td>
                  {canEdit(m) ? (
                    <select value={m.role} onChange={(e) => update(m.id, { role: e.target.value as Role })}>
                      {assignableRoles.map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </select>
                  ) : (
                    m.role
                  )}
                </td>
                <td>
                  <select
                    value={m.managerId ?? ''}
                    disabled={!canEditFlags(m)}
                    onChange={(e) => update(m.id, { managerId: e.target.value || null })}
                  >
                    <option value="">—</option>
                    {managers
                      .filter((x) => x.id !== m.id)
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.firstName} {x.lastName}
                        </option>
                      ))}
                  </select>
                </td>
                {departments.length > 0 && (
                  <td>
                    <select
                      value={m.departmentId ?? ''}
                      disabled={!canEditFlags(m)}
                      onChange={(e) => update(m.id, { departmentId: e.target.value || null })}
                    >
                      <option value="">—</option>
                      {departments.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </td>
                )}
                {locations.length > 0 && (
                  <td>
                    <select
                      value={m.locationId ?? ''}
                      disabled={!canEditFlags(m)}
                      onChange={(e) => update(m.id, { locationId: e.target.value || null })}
                    >
                      <option value="">—</option>
                      {locations.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </select>
                  </td>
                )}
                <td>
                  <input
                    type="checkbox"
                    checked={m.canReviewReports}
                    disabled={!canEditFlags(m)}
                    onChange={(e) => update(m.id, { canReviewReports: e.target.checked })}
                  />
                </td>
                <td>
                  {canEdit(m) ? (
                    <button
                      className="link"
                      onClick={() => update(m.id, { status: m.status === 'active' ? 'deactivated' : 'active' })}
                    >
                      {m.status === 'active' ? 'Deactivate' : 'Reactivate'}
                    </button>
                  ) : (
                    m.status
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
