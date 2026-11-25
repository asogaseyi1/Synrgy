import { useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { api, type PersonRef } from '../api.ts';
import { useMe } from '../auth.tsx';
import { date, time } from '../format.ts';
import { errorMessage, useApi } from '../useApi.ts';
import { REPORTER_STATUS_LABELS, reportDay, Thread, type ReportStatus } from './PublicReportPages.tsx';

export const REPORTS_CHANGED = 'synrgy:reports-changed';

const STATUS_LABELS: Record<ReportStatus, string> = {
  new: 'New',
  investigating: 'Investigating',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};

interface ReportSummary {
  id: string;
  trackingCode: string;
  category: string;
  status: ReportStatus;
  createdOn: string;
  updatedOn: string;
  closedOn: string | null;
  messageCount: number;
  needsAttention: boolean;
}

interface ReportDetail extends Omit<ReportSummary, 'messageCount' | 'needsAttention'> {
  description: string;
  incidentDate: string | null;
  location: string | null;
  peopleInvolved: string | null;
  messages: { seq: number; author: 'reporter' | 'reviewer'; body: string; createdOn: string; reviewer: PersonRef | null }[];
  accessLog: { id: string; action: string; at: string; data: { from?: string; to?: string }; actor: PersonRef | null }[];
}

// ---------- Everyone: how to report ----------

export function SpeakUpPage() {
  const { user, organization } = useMe();
  const formUrl = `${location.origin}/r/${organization.slug}`;
  const [copied, setCopied] = useState(false);
  return (
    <section className="narrow">
      <p className="eyebrow">Confidential</p>
      <h1>Speak up</h1>
      <p className="lead">
        If you've seen something that may break the law, our policies or the code of conduct, such as harassment, safety hazards,
        fraud or retaliation, you can report it <strong>anonymously</strong>.
      </p>
      <div className="card speak-up">
        <ul className="checklist">
          <li>The form doesn't know who you are, even though you're signed in here. No name, account, IP address or device is stored.</li>
          <li>Reports show only the date, not the time.</li>
          <li>Only designated reviewers can read reports, and each time one is opened it's logged.</li>
          <li>You'll get a tracking code and secret key so you can follow up and answer questions, still anonymously.</li>
        </ul>
        <div className="card-actions start">
          <a className="button" href={`/r/${organization.slug}`} target="_blank" rel="noreferrer noopener">
            Open the reporting form ↗
          </a>
          <a className="button secondary" href={`/r/${organization.slug}/status`} target="_blank" rel="noreferrer noopener">
            Check on a report
          </a>
        </div>
      </div>
      <div className="card">
        <h2 className="flush">Report from a personal device</h2>
        <p className="muted">
          If you're worried a work computer or network is monitored, open this address on your own phone or computer instead. You
          don't need to sign in.
        </p>
        <div className="share-link">
          <code>{formUrl}</code>
          <button
            className="secondary"
            onClick={() => void navigator.clipboard?.writeText(formUrl).then(() => setCopied(true), () => undefined)}
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      </div>
      {user.canReviewReports && (
        <p className="muted">
          You're a designated reviewer. <Link to="/reports">Go to the reports inbox →</Link>
        </p>
      )}
    </section>
  );
}

// ---------- Reviewers ----------

export function ReportsInboxPage() {
  const [params, setParams] = useSearchParams();
  const filter = (params.get('status') ?? 'open') as 'open' | 'closed' | 'all';
  const { data, error } = useApi(() => api.get<{ reports: ReportSummary[] }>(`/reports?status=${filter}`), [filter]);

  return (
    <section>
      <div className="page-head">
        <div>
          <p className="eyebrow">Confidential</p>
          <h1>Reports inbox</h1>
        </div>
        <div className="tabs small-tabs">
          {(['open', 'closed', 'all'] as const).map((f) => (
            <button key={f} className={filter === f ? 'active' : ''} onClick={() => setParams(f === 'open' ? {} : { status: f })}>
              {f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <p className="muted small">
        Reports are anonymous. Opening one is recorded in its access log, which every reviewer can see. Please don't try to
        identify the reporter.
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      {data && data.reports.length === 0 && <p className="empty">No {filter === 'all' ? '' : filter} reports.</p>}
      {data && data.reports.length > 0 && (
        <div className="table-wrap">
          <table className="reports-table">
            <thead>
              <tr>
                <th>Report</th>
                <th>Category</th>
                <th>Status</th>
                <th>Received</th>
                <th>Last activity</th>
                <th>Messages</th>
              </tr>
            </thead>
            <tbody>
              {data.reports.map((r) => (
                <tr key={r.id} className={r.needsAttention ? 'attention' : ''}>
                  <td>
                    <Link to={`/reports/${r.id}`} className="mono">
                      {r.trackingCode}
                    </Link>
                    {r.needsAttention && <span className="dot" title="Needs attention" aria-label="Needs attention" />}
                  </td>
                  <td>{r.category}</td>
                  <td>
                    <span className={`badge report-${r.status}`}>{STATUS_LABELS[r.status]}</span>
                  </td>
                  <td>{reportDay(r.createdOn)}</td>
                  <td>{reportDay(r.updatedOn)}</td>
                  <td>{r.messageCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const ACTION_LABELS: Record<string, string> = {
  'report.viewed': 'opened the report',
  'report.replied': 'replied',
  'report.status_changed': 'changed status',
};

export function ReportDetailPage() {
  const { reportId = '' } = useParams();
  const tz = useMe().organization.timezone;
  const { data, error, reload } = useApi(() => api.get<{ report: ReportDetail }>(`/reports/${reportId}`), [reportId]);
  const [report, setReport] = useState<ReportDetail | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const r = report ?? data?.report ?? null;

  const act = async (fn: () => Promise<{ report: ReportDetail }>) => {
    setBusy(true);
    setActionError(null);
    try {
      setReport((await fn()).report);
      window.dispatchEvent(new Event(REPORTS_CHANGED));
      return true;
    } catch (err) {
      setActionError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (await act(() => api.post(`/reports/${reportId}/messages`, { body: reply }))) setReply('');
  };

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!r) return <p className="loading">Loading…</p>;

  return (
    <section className="narrow-wide">
      <p className="eyebrow">
        <Link to="/reports">Reports</Link> / <span className="mono">{r.trackingCode}</span>
      </p>
      <div className="page-head">
        <h1>{r.category}</h1>
        <label className="inline-label">
          Status
          <select
            value={r.status}
            disabled={busy}
            onChange={(e) => void act(() => api.patch(`/reports/${reportId}`, { status: e.target.value }))}
          >
            {(Object.keys(STATUS_LABELS) as ReportStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {actionError && <p className="error" role="alert">{actionError}</p>}

      <article className="card">
        <div className="kv small report-facts">
          <span className="muted">Received</span>
          <span>{reportDay(r.createdOn)}</span>
          {r.incidentDate && (
            <>
              <span className="muted">Happened</span>
              <span>{reportDay(r.incidentDate)}</span>
            </>
          )}
          {r.location && (
            <>
              <span className="muted">Where</span>
              <span>{r.location}</span>
            </>
          )}
          {r.peopleInvolved && (
            <>
              <span className="muted">Involved</span>
              <span>{r.peopleInvolved}</span>
            </>
          )}
          {r.closedOn && (
            <>
              <span className="muted">Closed</span>
              <span>{reportDay(r.closedOn)}</span>
            </>
          )}
          <span className="muted">Reporter sees</span>
          <span>“{REPORTER_STATUS_LABELS[r.status]}”</span>
        </div>
        <div className="ann-body report-description">{r.description}</div>
      </article>

      <h2>Conversation with the reporter</h2>
      {r.messages.length === 0 && <p className="empty">No messages yet. Ask a question or let them know it's being looked at.</p>}
      <Thread
        mine="reviewer"
        messages={r.messages.map((m) => ({
          ...m,
          who: m.author === 'reporter' ? 'Reporter' : m.reviewer ? `${m.reviewer.firstName} ${m.reviewer.lastName}` : 'Former reviewer',
        }))}
      />
      <form onSubmit={send} className="card">
        <label>
          Reply to the reporter
          <textarea rows={4} value={reply} required maxLength={5000} onChange={(e) => setReply(e.target.value)} />
        </label>
        <p className="muted small flush">The reporter sees replies as coming from “Investigator”, not from you by name.</p>
        <div className="card-actions">
          <button disabled={busy || !reply.trim()}>Send reply</button>
        </div>
      </form>

      <details className="card access-log">
        <summary>
          <strong>Access log</strong> <span className="muted small">({r.accessLog.length} entries)</span>
        </summary>
        <ul>
          {r.accessLog.map((a) => (
            <li key={a.id}>
              <strong>{a.actor ? `${a.actor.firstName} ${a.actor.lastName}` : 'Former reviewer'}</strong>{' '}
              {ACTION_LABELS[a.action] ?? a.action}
              {a.data?.to && (
                <>
                  {' '}
                  to <em>{STATUS_LABELS[a.data.to as ReportStatus] ?? a.data.to}</em>
                </>
              )}
              <span className="muted small">
                {' '}
                · {date(a.at, tz)} {time(a.at, tz)}
              </span>
            </li>
          ))}
        </ul>
        <button type="button" className="link small" onClick={() => void reload().then(() => setReport(null))}>
          Refresh
        </button>
      </details>
    </section>
  );
}
