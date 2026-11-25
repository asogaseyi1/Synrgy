import { useState, type FormEvent } from 'react';
import { api, type Me } from '../api.ts';
import { useAuth, useMe } from '../auth.tsx';
import { errorMessage } from '../useApi.ts';

type Msg = { ok: boolean; text: string } | null;

export function AccountPage() {
  const { user, organization } = useMe();
  const { setMe } = useAuth();
  const [firstName, setFirstName] = useState(user.firstName);
  const [lastName, setLastName] = useState(user.lastName);
  const [notify, setNotify] = useState(user.emailNotifications);
  const [profileMsg, setProfileMsg] = useState<Msg>(null);
  const [pwMsg, setPwMsg] = useState<Msg>(null);

  const saveProfile = async (e: FormEvent) => {
    e.preventDefault();
    setProfileMsg(null);
    try {
      setMe(await api.patch<Me>('/auth/me', { firstName, lastName, emailNotifications: notify }));
      setProfileMsg({ ok: true, text: 'Saved.' });
    } catch (err) {
      setProfileMsg({ ok: false, text: errorMessage(err) });
    }
  };

  const changePassword = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const v = Object.fromEntries(new FormData(form)) as Record<string, string>;
    setPwMsg(null);
    if (v.newPassword !== v.confirm) return setPwMsg({ ok: false, text: "The new passwords don't match" });
    try {
      await api.post('/auth/password', { currentPassword: v.currentPassword, newPassword: v.newPassword });
      form.reset();
      setPwMsg({ ok: true, text: 'Password changed. Other devices have been signed out.' });
    } catch (err) {
      setPwMsg({ ok: false, text: errorMessage(err) });
    }
  };

  return (
    <section className="narrow">
      <p className="eyebrow">{organization.name}</p>
      <h1>Your account</h1>

      <form className="card" onSubmit={saveProfile}>
        <h2 className="flush">Profile</h2>
        <div className="row">
          <label>
            First name
            <input value={firstName} required maxLength={100} onChange={(e) => setFirstName(e.target.value)} />
          </label>
          <label>
            Last name
            <input value={lastName} required maxLength={100} onChange={(e) => setLastName(e.target.value)} />
          </label>
        </div>
        <div className="kv small">
          <span className="muted">Email</span>
          <span>{user.email}</span>
          <span className="muted">Role</span>
          <span className="capitalize">{user.role}</span>
        </div>
        <label className="check">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
          <span>
            Email me about requests and approvals
            <span className="muted small">Swap requests, time corrections and their outcomes. Password and invite emails always send.</span>
          </span>
        </label>
        {profileMsg && <p className={profileMsg.ok ? 'notice' : 'error'}>{profileMsg.text}</p>}
        <div className="card-actions">
          <button>Save</button>
        </div>
      </form>

      <form className="card" onSubmit={changePassword}>
        <h2 className="flush">Change password</h2>
        <label>
          Current password
          <input name="currentPassword" type="password" required autoComplete="current-password" />
        </label>
        <div className="row">
          <label>
            New password
            <input name="newPassword" type="password" minLength={8} required autoComplete="new-password" />
          </label>
          <label>
            Confirm
            <input name="confirm" type="password" minLength={8} required autoComplete="new-password" />
          </label>
        </div>
        {pwMsg && <p className={pwMsg.ok ? 'notice' : 'error'}>{pwMsg.text}</p>}
        <div className="card-actions">
          <button>Change password</button>
        </div>
      </form>
    </section>
  );
}
