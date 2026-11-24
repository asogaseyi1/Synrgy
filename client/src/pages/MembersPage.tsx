import { useState, type FormEvent } from 'react';
import { api, atLeast, type Role, type User } from '../api.ts';
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
  const [inviteLink, setInviteLink] = useState<string | null>(null);

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
      const res = await api.post<{ acceptUrl: string }>('/members/invitations', values);
      // Point the link at wherever this UI is actually served.
      setInviteLink(res.acceptUrl.replace(/^https?:\/\/[^/]+/, window.location.origin));
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
          Share this invite link (email delivery is coming later): <code>{inviteLink}</code>
        </p>
      )}
      {error && <p className="error">{error}</p>}

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
