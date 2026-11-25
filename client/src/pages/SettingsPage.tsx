import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api, type Organization, type OrgSettings, type OrgUnit, type User } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { errorMessage, useApi } from '../useApi.ts';

type Msg = { ok: boolean; text: string } | null;
type Org = Organization & { settings: OrgSettings };

const TIMEZONES: string[] = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];

/** A settings card with its own save button and message. */
function Section({ title, intro, onSave, children }: { title: string; intro?: ReactNode; onSave: () => Promise<void>; children: ReactNode }) {
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      await onSave();
      setMsg({ ok: true, text: 'Saved.' });
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card" onSubmit={submit}>
      <h2 className="flush">{title}</h2>
      {intro && <p className="muted small flush">{intro}</p>}
      {children}
      {msg && <p className={msg.ok ? 'notice' : 'error'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
      <div className="card-actions">
        <button disabled={busy}>Save</button>
      </div>
    </form>
  );
}

/** Checkbox that turns a nullable number on/off, with the number input beside it. */
function OptionalNumber({
  label,
  hint,
  value,
  fallback,
  unit,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  hint: string;
  value: number | null;
  fallback: number;
  unit: string;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number | null) => void;
}) {
  return (
    <>
      <label className="check">
        <input type="checkbox" checked={value !== null} onChange={(e) => onChange(e.target.checked ? fallback : null)} />
        <span>
          {label}
          <span className="muted small">{hint}</span>
        </span>
      </label>
      {value !== null && (
        <label className="inline-label indent">
          <input type="number" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
          {unit}
        </label>
      )}
    </>
  );
}

export function SettingsPage() {
  const { refresh } = useAuth();
  const { data, error, reload } = useApi(() => api.get<{ organization: Org }>('/organization'));
  const members = useApi(() => api.get<{ members: User[] }>('/members'));
  const [s, setS] = useState<OrgSettings | null>(null);
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('');
  const [categories, setCategories] = useState('');

  useEffect(() => {
    if (!data) return;
    setS(data.organization.settings);
    setName(data.organization.name);
    setTimezone(data.organization.timezone);
    setCategories(data.organization.settings.reportCategories.join('\n'));
  }, [data]);

  const set = <K extends keyof OrgSettings>(k: K, v: OrgSettings[K]) => setS((cur) => (cur ? { ...cur, [k]: v } : cur));
  const saveSettings = async (patch: Partial<OrgSettings>) => {
    await api.patch('/organization/settings', patch);
    await reload();
  };

  const reviewers = members.data?.members.filter((m) => m.canReviewReports && m.status === 'active') ?? [];

  return (
    <section className="narrow">
      <p className="eyebrow">Admin</p>
      <h1>Workspace settings</h1>
      {error && <p className="error" role="alert">{error}</p>}
      {data && s && (
        <>
          <Section
            title="General"
            onSave={async () => {
              await api.patch('/organization', { name, timezone });
              await saveSettings({ weekStartsOn: s.weekStartsOn });
              await refresh();
            }}
          >
            <label>
              Company name
              <input value={name} required minLength={2} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="row">
              <label>
                Time zone
                <input list="tz-list" value={timezone} required onChange={(e) => setTimezone(e.target.value)} />
                <datalist id="tz-list">
                  {TIMEZONES.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </label>
              <label>
                Week starts on
                <select value={s.weekStartsOn} onChange={(e) => set('weekStartsOn', Number(e.target.value) as 0 | 1)}>
                  <option value={1}>Monday</option>
                  <option value={0}>Sunday</option>
                </select>
              </label>
            </div>
            <div className="kv small">
              <span className="muted">Workspace ID</span>
              <code>{data.organization.slug}</code>
            </div>
            <p className="muted small flush">
              The time zone decides which day a shift belongs to on timesheets, payroll and schedules.
            </p>
          </Section>

          <Section
            title="Time clock"
            onSave={() => saveSettings({ staleOpenHours: s.staleOpenHours, correctionWindowDays: s.correctionWindowDays })}
          >
            <div className="row">
              <label>
                Flag forgotten clock-outs after
                <span className="input-unit">
                  <input type="number" min={4} max={48} value={s.staleOpenHours} onChange={(e) => set('staleOpenHours', Number(e.target.value))} />
                  hours
                </span>
              </label>
              <label>
                Corrections allowed for the last
                <span className="input-unit">
                  <input type="number" min={1} max={366} value={s.correctionWindowDays} onChange={(e) => set('correctionWindowDays', Number(e.target.value))} />
                  days
                </span>
              </label>
            </div>
          </Section>

          <Section
            title="Pay rules"
            intro="Applied to payroll totals and CSV exports. Raw punches are never changed."
            onSave={() =>
              saveSettings({
                roundingMinutes: s.roundingMinutes,
                autoBreakAfterHours: s.autoBreakAfterHours,
                autoBreakMinutes: s.autoBreakMinutes,
                dailyOvertimeHours: s.dailyOvertimeHours,
                weeklyOvertimeHours: s.weeklyOvertimeHours,
              })
            }
          >
            <label>
              Round clock-in and clock-out
              <select value={s.roundingMinutes} onChange={(e) => set('roundingMinutes', Number(e.target.value) as OrgSettings['roundingMinutes'])}>
                <option value={0}>Don't round (exact minutes)</option>
                {[5, 6, 10, 15, 30].map((m) => (
                  <option key={m} value={m}>
                    To the nearest {m} minutes
                  </option>
                ))}
              </select>
            </label>
            <OptionalNumber
              label="Auto-deduct an unpaid break on long shifts"
              hint={`Only the shortfall is deducted: if someone took 10 of ${s.autoBreakMinutes} minutes, ${Math.max(0, s.autoBreakMinutes - 10)} more come off.`}
              value={s.autoBreakAfterHours}
              fallback={6}
              unit="hours or longer"
              min={1}
              max={24}
              step={0.5}
              onChange={(v) => set('autoBreakAfterHours', v)}
            />
            {s.autoBreakAfterHours !== null && (
              <label className="inline-label indent">
                <input type="number" min={5} max={120} value={s.autoBreakMinutes} onChange={(e) => set('autoBreakMinutes', Number(e.target.value))} />
                minute break
              </label>
            )}
            <OptionalNumber
              label="Daily overtime"
              hint="Time over this many hours in a day counts as overtime."
              value={s.dailyOvertimeHours}
              fallback={8}
              unit="hours per day"
              min={1}
              max={24}
              step={0.5}
              onChange={(v) => set('dailyOvertimeHours', v)}
            />
            <OptionalNumber
              label="Weekly overtime"
              hint="Remaining time over this many hours in a week counts as overtime."
              value={s.weeklyOvertimeHours}
              fallback={40}
              unit="hours per week"
              min={1}
              max={168}
              step={0.5}
              onChange={(v) => set('weeklyOvertimeHours', v)}
            />
          </Section>

          <Section
            title="Shift swaps"
            onSave={() => saveSettings({ requireSwapApproval: s.requireSwapApproval, maxWeeklyHours: s.maxWeeklyHours })}
          >
            <label className="check">
              <input type="checkbox" checked={s.requireSwapApproval} onChange={(e) => set('requireSwapApproval', e.target.checked)} />
              <span>
                Require manager approval
                <span className="muted small">When off, a swap goes through as soon as the coworker accepts.</span>
              </span>
            </label>
            <OptionalNumber
              label="Limit scheduled hours per week"
              hint="Blocks swaps that would push someone over the limit."
              value={s.maxWeeklyHours}
              fallback={40}
              unit="hours per week"
              min={1}
              max={168}
              onChange={(v) => set('maxWeeklyHours', v)}
            />
          </Section>

          <UnitsCard />

          <Section
            title="Confidential reporting"
            intro="Share this link in your handbook or on posters. Anyone with it can report anonymously, without signing in."
            onSave={() =>
              saveSettings({
                reportCategories: categories
                  .split('\n')
                  .map((c) => c.trim())
                  .filter(Boolean),
              })
            }
          >
            <div className="share-link">
              <code>{`${location.origin}/r/${data.organization.slug}`}</code>
            </div>
            <div>
              <strong className="small">Reviewers</strong>
              {members.data && reviewers.length === 0 && (
                <p className="error small" role="alert">Nobody can read reports right now. Choose at least one reviewer on the People page.</p>
              )}
              {reviewers.length > 0 && (
                <p className="small flush">
                  {reviewers.map((r) => `${r.firstName} ${r.lastName}`).join(', ')}{' '}
                  <span className="muted">
                    · change on the <Link to="/people">People</Link> page
                  </span>
                </p>
              )}
              <p className="muted small flush">
                Pick reviewers who are independent of the people likely to be reported. Being an admin doesn't give access.
              </p>
            </div>
            <label>
              Report categories <span className="muted">(one per line)</span>
              <textarea rows={7} value={categories} onChange={(e) => setCategories(e.target.value)} />
            </label>
          </Section>
        </>
      )}
    </section>
  );
}

function UnitsCard() {
  const { data, error, reload } = useApi(() => api.get<{ units: OrgUnit[] }>('/organization/units'));
  const [actionError, setActionError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  const column = (kind: OrgUnit['kind'], title: string, placeholder: string) => {
    const list = data?.units.filter((u) => u.kind === kind) ?? [];
    return (
      <div className="unit-column">
        <h3>{title}</h3>
        {list.length === 0 && <p className="muted small">None yet.</p>}
        <ul className="unit-list">
          {list.map((u) => (
            <li key={u.id}>
              <span>
                {u.name} <span className="muted small">· {u.memberCount}</span>
              </span>
              <span className="row-actions">
                <button
                  type="button"
                  className="link small"
                  onClick={() => {
                    const next = prompt(`Rename "${u.name}"`, u.name)?.trim();
                    if (next && next !== u.name) void run(() => api.patch(`/organization/units/${u.id}`, { name: next }));
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="link small danger-link"
                  onClick={() => {
                    if (confirm(`Delete "${u.name}"? ${u.memberCount} people will be unassigned.`))
                      void run(() => api.del(`/organization/units/${u.id}`));
                  }}
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const name = String(new FormData(form).get('name') ?? '').trim();
            if (name) void run(() => api.post('/organization/units', { kind, name })).then(() => form.reset());
          }}
        >
          <input name="name" placeholder={placeholder} maxLength={100} required />
          <button className="secondary">Add</button>
        </form>
      </div>
    );
  };

  return (
    <div className="card">
      <h2 className="flush">Departments & locations</h2>
      <p className="muted small flush">Group people to filter payroll and target announcements. Assign people on the People page.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {actionError && <p className="error" role="alert">{actionError}</p>}
      <div className="units-grid">
        {column('department', 'Departments', 'e.g. Kitchen')}
        {column('location', 'Locations', 'e.g. Downtown store')}
      </div>
    </div>
  );
}
