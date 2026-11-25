import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError, type Me, type Organization, type User } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { Brand } from '../Brand.tsx';
import { errorMessage, useApi } from '../useApi.ts';

function formData(e: FormEvent<HTMLFormElement>) {
  return Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
}

function useSubmit(action: (values: Record<string, string>) => Promise<void>) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await action(formData(e));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, onSubmit };
}

export function LoginPage() {
  const { setMe } = useAuth();
  const navigate = useNavigate();
  const { error, busy, onSubmit } = useSubmit(async (v) => {
    setMe(await api.post<Me>('/auth/login', v));
    navigate('/');
  });

  return (
    <main className="auth-page">
      <div className="auth-card">
      <Brand />
      <h1>Welcome back</h1>
      <p className="subtitle">Sign in to your workspace.</p>
      <form onSubmit={onSubmit}>
        <label>
          Workspace
          <input name="workspace" required autoComplete="organization" placeholder="acme" />
        </label>
        <label>
          Email
          <input name="email" type="email" required autoComplete="email" />
        </label>
        <label>
          Password
          <input name="password" type="password" required autoComplete="current-password" />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button disabled={busy}>Sign in</button>
      </form>
      <p className="footer">
        <Link to="/forgot">Forgot your password?</Link>
        <br />
        New company? <Link to="/register">Create a workspace</Link>
      </p>
      </div>
    </main>
  );
}

export function RegisterPage() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [slug, setSlug] = useState('');
  const { error, busy, onSubmit } = useSubmit(async (v) => {
    await api.post<{ organization: Organization; user: User }>('/auth/register-organization', v);
    await refresh();
    navigate('/');
  });

  return (
    <main className="auth-page">
      <div className="auth-card">
      <Brand />
      <h1>Create your workspace</h1>
      <p className="subtitle">Set up Synrgy for your team in under a minute.</p>
      <form onSubmit={onSubmit}>
        <label>
          Company name
          <input
            name="organizationName"
            required
            onChange={(e) =>
              setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40))
            }
          />
        </label>
        <label>
          Workspace ID <span className="muted">(used to sign in)</span>
          <input name="slug" required value={slug} onChange={(e) => setSlug(e.target.value)} />
        </label>
        <label>
          Time zone
          <input name="timezone" required defaultValue={browserTz} />
        </label>
        <div className="row">
          <label>
            First name
            <input name="firstName" required />
          </label>
          <label>
            Last name
            <input name="lastName" required />
          </label>
        </div>
        <label>
          Work email
          <input name="email" type="email" required />
        </label>
        <label>
          Password
          <input name="password" type="password" minLength={8} required autoComplete="new-password" />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button disabled={busy}>Create workspace</button>
      </form>
      <p className="footer">
        Already have one? <Link to="/login">Sign in</Link>
      </p>
      </div>
    </main>
  );
}

export function AcceptInvitePage() {
  const { token = '' } = useParams();
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const { data, error: loadError } = useApi(
    () => api.get<{ invitation: { email: string; role: string; organizationName: string } }>(`/invitations/${token}`),
    [token],
  );
  const { error, busy, onSubmit } = useSubmit(async (v) => {
    await api.post(`/invitations/${token}/accept`, v);
    await refresh();
    navigate('/');
  });

  if (loadError)
    return (
      <main className="auth-page">
        <div className="auth-card">
          <Brand />
          <p className="error" role="alert">{loadError}</p>
        </div>
      </main>
    );
  if (!data) return <p className="loading">Loading…</p>;
  const inv = data.invitation;

  return (
    <main className="auth-page">
      <div className="auth-card">
      <Brand />
      <h1>Join {inv.organizationName}</h1>
      <p className="subtitle">
        You were invited as <strong>{inv.role}</strong> ({inv.email}).
      </p>
      <form onSubmit={onSubmit}>
        <div className="row">
          <label>
            First name
            <input name="firstName" required />
          </label>
          <label>
            Last name
            <input name="lastName" required />
          </label>
        </div>
        <label>
          Choose a password
          <input name="password" type="password" minLength={8} required autoComplete="new-password" />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button disabled={busy}>Join</button>
      </form>
      </div>
    </main>
  );
}

export function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const { error, busy, onSubmit } = useSubmit(async (v) => {
    await api.post('/auth/password-reset', v);
    setSent(true);
  });

  return (
    <main className="auth-page">
      <div className="auth-card">
        <Brand />
        <h1>Reset your password</h1>
        {sent ? (
          <p className="notice">
            If that account exists, we've emailed a link to reset the password. It expires in an hour. Check your spam folder if it
            doesn't arrive.
          </p>
        ) : (
          <>
            <p className="subtitle">We'll email you a link to choose a new one.</p>
            <form onSubmit={onSubmit}>
              <label>
                Workspace
                <input name="workspace" required autoComplete="organization" placeholder="acme" />
              </label>
              <label>
                Email
                <input name="email" type="email" required autoComplete="email" />
              </label>
              {error && <p className="error" role="alert">{error}</p>}
              <button disabled={busy}>Send reset link</button>
            </form>
          </>
        )}
        <p className="footer">
          <Link to="/login">Back to sign in</Link>
        </p>
      </div>
    </main>
  );
}

export function ResetPasswordPage() {
  const { token = '' } = useParams();
  const { setMe } = useAuth();
  const navigate = useNavigate();
  const { data, error: loadError } = useApi(
    () => api.get<{ firstName: string; organizationName: string }>(`/auth/password-reset/${token}`),
    [token],
  );
  const { error, busy, onSubmit } = useSubmit(async (v) => {
    if (v.password !== v.confirm) throw new ApiError(400, 'mismatch', "The passwords don't match");
    setMe(await api.post<Me>(`/auth/password-reset/${token}`, { password: v.password }));
    navigate('/');
  });

  return (
    <main className="auth-page">
      <div className="auth-card">
        <Brand />
        {loadError ? (
          <>
            <h1>Link expired</h1>
            <p className="error" role="alert">{loadError}</p>
            <p className="footer">
              <Link to="/forgot">Request a new link</Link>
            </p>
          </>
        ) : !data ? (
          <p>Loading…</p>
        ) : (
          <>
            <h1>Choose a new password</h1>
            <p className="subtitle">
              Hi {data.firstName}, set a new password for {data.organizationName}. You'll be signed out on other devices.
            </p>
            <form onSubmit={onSubmit}>
              <label>
                New password
                <input name="password" type="password" minLength={8} required autoComplete="new-password" />
              </label>
              <label>
                Confirm new password
                <input name="confirm" type="password" minLength={8} required autoComplete="new-password" />
              </label>
              {error && <p className="error" role="alert">{error}</p>}
              <button disabled={busy}>Save password and sign in</button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
