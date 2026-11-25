import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useParams } from 'react-router';
import { ApiError } from '../api.ts';
import { Brand } from '../Brand.tsx';
import { formatDay } from '../tz.ts';
import { errorMessage } from '../useApi.ts';

/*
 * The anonymous reporting site (/r/:workspace). Rendered outside the signed-in app:
 * no AuthProvider, no /auth/me call, requests sent without cookies, nothing kept in
 * browser storage. The code and key live only in component state.
 */

async function publicRequest<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/public/reports${path}`, {
    method,
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error ?? {};
    throw new ApiError(res.status, e.code ?? 'unknown', e.message ?? res.statusText, e.details);
  }
  return data as T;
}

export type ReportStatus = 'new' | 'investigating' | 'resolved' | 'dismissed';

export const REPORTER_STATUS_LABELS: Record<ReportStatus, string> = {
  new: 'Received',
  investigating: 'Being looked into',
  resolved: 'Resolved',
  dismissed: 'Closed',
};

export const reportDay = (ymd: string) => formatDay(ymd, { month: 'short', day: 'numeric', year: 'numeric' });

interface FormInfo {
  organization: { name: string; slug: string };
  categories: string[];
}

interface ReporterView {
  trackingCode: string;
  category: string;
  description: string;
  incidentDate: string | null;
  location: string | null;
  peopleInvolved: string | null;
  status: ReportStatus;
  createdOn: string;
  closedOn: string | null;
  messages: { seq: number; author: 'reporter' | 'reviewer'; body: string; createdOn: string }[];
}

export function PublicReportRoutes() {
  return (
    <Routes>
      <Route path="/r/:slug" element={<ReportFormPage />} />
      <Route path="/r/:slug/status" element={<ReportStatusPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function Shell({ org, children }: { org?: string; children: ReactNode }) {
  return (
    <main className="auth-page report-site">
      <div className="auth-card report-card">
        <div className="report-site-head">
          <Brand />
          {org && <span className="muted small">Confidential reporting · {org}</span>}
        </div>
        {children}
      </div>
    </main>
  );
}

function useFormInfo(slug: string) {
  const [info, setInfo] = useState<FormInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    publicRequest<FormInfo>('GET', `/orgs/${encodeURIComponent(slug)}`).then(setInfo, (err) => setError(errorMessage(err)));
  }, [slug]);
  return { info, error };
}

function PrivacyNotice() {
  return (
    <details className="privacy" open>
      <summary>🔒 How your anonymity is protected</summary>
      <ul>
        <li>We don't record your name, account, IP address, browser or device, even if you're signed in to Synrgy.</li>
        <li>Reports carry the <strong>date only</strong>, never the time, so they can't be matched to clock-ins.</li>
        <li>Only the people your organization designated as reviewers can read it, and every time they open it is logged.</li>
        <li>You'll get a tracking code and secret key to follow up. Nobody else, including us, can recover them.</li>
      </ul>
      <p className="small muted">
        Tips: if your employer monitors its network or devices, use a personal phone or computer on a non-work connection. Leave
        out details that would point to you, unless you want to include them.
      </p>
    </details>
  );
}

function ReportFormPage() {
  const { slug = '' } = useParams();
  const { info, error } = useFormInfo(slug);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<{ trackingCode: string; accessKey: string } | null>(null);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    setSubmitError(null);
    try {
      setReceipt(
        await publicRequest('POST', `/orgs/${encodeURIComponent(slug)}/reports`, {
          category: v.category,
          description: v.description,
          incidentDate: v.incidentDate || null,
          location: v.location,
          peopleInvolved: v.peopleInvolved,
        }),
      );
      window.scrollTo(0, 0);
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <Shell>
        <h1>Workspace not found</h1>
        <p className="error">{error}</p>
      </Shell>
    );
  }
  if (!info) return <Shell>Loading…</Shell>;
  if (receipt) return <Receipt org={info.organization} receipt={receipt} />;

  return (
    <Shell org={info.organization.name}>
      <h1>Report a concern</h1>
      <p className="subtitle">
        Tell {info.organization.name} about possible misconduct, safety issues or code violations, anonymously.
      </p>
      <PrivacyNotice />
      <form onSubmit={submit}>
        <label>
          What is this about?
          <select name="category" required defaultValue="">
            <option value="" disabled>
              Choose a category
            </option>
            {info.categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          What happened?
          <textarea
            name="description"
            rows={8}
            required
            minLength={10}
            maxLength={10000}
            placeholder="Describe what happened, as specifically as you can. What did you see or hear?"
          />
        </label>
        <div className="row">
          <label>
            When <span className="muted">(optional)</span>
            <input type="date" name="incidentDate" />
          </label>
          <label>
            Where <span className="muted">(optional)</span>
            <input name="location" maxLength={200} placeholder="Site, department, online…" />
          </label>
        </div>
        <label>
          Who was involved? <span className="muted">(optional)</span>
          <input name="peopleInvolved" maxLength={500} placeholder="Names or roles of the people involved or who witnessed it" />
        </label>
        {submitError && <p className="error">{submitError}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Submit anonymously'}
        </button>
      </form>
      <p className="footer">
        Already reported something? <Link to={`/r/${slug}/status`}>Check on your report</Link>
      </p>
    </Shell>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="secondary small-btn"
      onClick={() => void navigator.clipboard?.writeText(text).then(() => setDone(true), () => undefined)}
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

function Receipt({ org, receipt }: { org: FormInfo['organization']; receipt: { trackingCode: string; accessKey: string } }) {
  const [saved, setSaved] = useState(false);
  const download = () => {
    const text = `${org.name}: confidential report\n\nCheck status at: ${location.origin}/r/${org.slug}/status\nTracking code: ${receipt.trackingCode}\nSecret key: ${receipt.accessKey}\n\nKeep this private. Anyone with both can read your report.\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `report-${receipt.trackingCode}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Shell org={org.name}>
      <p className="eyebrow">Report sent</p>
      <h1>Save these now</h1>
      <p className="subtitle">
        You'll need both to check for updates or answer questions from the investigators. <strong>They're shown only once</strong> and
        can't be recovered.
      </p>
      <div className="secret">
        <span className="muted small">Tracking code</span>
        <code>{receipt.trackingCode}</code>
        <CopyButton text={receipt.trackingCode} />
        <span className="muted small">Secret key</span>
        <code>{receipt.accessKey}</code>
        <CopyButton text={receipt.accessKey} />
      </div>
      <div className="card-actions">
        <button type="button" className="secondary" onClick={download}>
          Download as a text file
        </button>
      </div>
      <label className="check">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>I've saved my tracking code and secret key somewhere safe</span>
      </label>
      {saved && (
        <p className="notice">
          Thank you for speaking up. Check back in a few days at <Link to={`/r/${org.slug}/status`}>the status page</Link>; the
          investigators may have questions for you.
        </p>
      )}
    </Shell>
  );
}

function ReportStatusPage() {
  const { slug = '' } = useParams();
  const { info, error } = useFormInfo(slug);
  const [cred, setCred] = useState<{ trackingCode: string; accessKey: string } | null>(null);
  const [report, setReport] = useState<ReporterView | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);

  const open = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.currentTarget)) as { trackingCode: string; accessKey: string };
    setBusy(true);
    setFormError(null);
    try {
      const res = await publicRequest<{ report: ReporterView }>('POST', '/access', { workspace: slug, ...v });
      setCred(v);
      setReport(res.report);
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!cred) return;
    setBusy(true);
    setFormError(null);
    try {
      const res = await publicRequest<{ report: ReporterView }>('POST', '/messages', { workspace: slug, ...cred, body: reply });
      setReport(res.report);
      setReply('');
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <Shell>
        <h1>Workspace not found</h1>
        <p className="error">{error}</p>
      </Shell>
    );
  }

  if (!report) {
    return (
      <Shell org={info?.organization.name}>
        <h1>Check on your report</h1>
        <p className="subtitle">Enter the tracking code and secret key you saved when you reported.</p>
        <form onSubmit={open} autoComplete="off">
          <label>
            Tracking code
            <input name="trackingCode" required placeholder="XXXXX-XXXXX" spellCheck={false} className="mono" />
          </label>
          <label>
            Secret key
            <input name="accessKey" type="password" required placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" spellCheck={false} className="mono" />
          </label>
          {formError && <p className="error">{formError}</p>}
          <button type="submit" disabled={busy}>
            View my report
          </button>
        </form>
        <p className="footer">
          <Link to={`/r/${slug}`}>Make a new report</Link>
        </p>
      </Shell>
    );
  }

  const closed = report.status === 'resolved' || report.status === 'dismissed';
  return (
    <Shell org={info?.organization.name}>
      <div className="page-head">
        <div>
          <p className="eyebrow">Report {report.trackingCode}</p>
          <h1>{report.category}</h1>
        </div>
        <span className={`badge report-${report.status}`}>{REPORTER_STATUS_LABELS[report.status]}</span>
      </div>
      <ol className="progress-steps">
        <li className="done">Received {reportDay(report.createdOn)}</li>
        <li className={report.status !== 'new' ? 'done' : ''}>Under review</li>
        <li className={closed ? 'done' : ''}>{closed && report.closedOn ? `Closed ${reportDay(report.closedOn)}` : 'Closed'}</li>
      </ol>
      <details className="report-original">
        <summary>Your original report</summary>
        <p className="ann-body">{report.description}</p>
        <div className="kv small">
          {report.incidentDate && (
            <>
              <span className="muted">When</span>
              <span>{reportDay(report.incidentDate)}</span>
            </>
          )}
          {report.location && (
            <>
              <span className="muted">Where</span>
              <span>{report.location}</span>
            </>
          )}
          {report.peopleInvolved && (
            <>
              <span className="muted">Involved</span>
              <span>{report.peopleInvolved}</span>
            </>
          )}
        </div>
      </details>

      <h2>Messages</h2>
      {report.messages.length === 0 && <p className="empty">No messages yet. Investigators will post questions or updates here.</p>}
      <Thread messages={report.messages.map((m) => ({ ...m, who: m.author === 'reporter' ? 'You' : 'Investigator' }))} mine="reporter" />
      {closed ? (
        <p className="notice">This report is closed. If something new has happened, please make a new report.</p>
      ) : (
        <form onSubmit={send}>
          <label>
            Reply anonymously
            <textarea rows={4} value={reply} required maxLength={5000} onChange={(e) => setReply(e.target.value)} />
          </label>
          {formError && <p className="error">{formError}</p>}
          <button type="submit" disabled={busy || !reply.trim()}>
            Send reply
          </button>
        </form>
      )}
      <p className="footer">
        <button
          className="link"
          onClick={() => {
            setReport(null);
            setCred(null);
          }}
        >
          Close and forget this report on this device
        </button>
      </p>
    </Shell>
  );
}

/** Message thread used by both the reporter and reviewer views. */
export function Thread({
  messages,
  mine,
}: {
  messages: { seq: number; author: 'reporter' | 'reviewer'; body: string; createdOn: string; who: string }[];
  mine: 'reporter' | 'reviewer';
}) {
  return (
    <div className="thread">
      {messages.map((m) => (
        <div key={m.seq} className={`bubble ${m.author === mine ? 'mine' : 'theirs'} from-${m.author}`}>
          <div className="bubble-meta small">
            <strong>{m.who}</strong> · {reportDay(m.createdOn)}
          </div>
          <div className="ann-body">{m.body}</div>
        </div>
      ))}
    </div>
  );
}
