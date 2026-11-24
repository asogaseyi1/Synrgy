import { useEffect, useState, type FormEvent } from 'react';
import { api, type Organization, type OrgSettings } from '../api.ts';
import { errorMessage, useApi } from '../useApi.ts';

export function SettingsPage() {
  const { data, error } = useApi(() => api.get<{ organization: Organization & { settings: OrgSettings } }>('/organization'));
  const [requireApproval, setRequireApproval] = useState(true);
  const [capOn, setCapOn] = useState(false);
  const [cap, setCap] = useState(40);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!data) return;
    const s = data.organization.settings;
    setRequireApproval(s.requireSwapApproval);
    setCapOn(s.maxWeeklyHours !== null);
    setCap(s.maxWeeklyHours ?? 40);
  }, [data]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    try {
      await api.patch('/organization/settings', { requireSwapApproval: requireApproval, maxWeeklyHours: capOn ? cap : null });
      setMsg({ ok: true, text: 'Settings saved.' });
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    }
  };

  return (
    <section className="narrow">
      <p className="eyebrow">Admin</p>
      <h1>Workspace settings</h1>
      {error && <p className="error">{error}</p>}
      {data && (
        <>
          <div className="card">
            <div className="kv">
              <span className="muted">Workspace</span>
              <strong>{data.organization.name}</strong>
              <span className="muted">Workspace ID</span>
              <code>{data.organization.slug}</code>
              <span className="muted">Time zone</span>
              <span>{data.organization.timezone.replace(/_/g, ' ')}</span>
            </div>
          </div>
          <form className="card" onSubmit={save}>
            <h2 className="flush">Shift swaps</h2>
            <label className="check">
              <input type="checkbox" checked={requireApproval} onChange={(e) => setRequireApproval(e.target.checked)} />
              <span>
                Require manager approval
                <span className="muted small">When off, a swap goes through as soon as the coworker accepts.</span>
              </span>
            </label>
            <label className="check">
              <input type="checkbox" checked={capOn} onChange={(e) => setCapOn(e.target.checked)} />
              <span>
                Limit scheduled hours per week
                <span className="muted small">Blocks swaps that would push someone over the limit (Mon–Sun).</span>
              </span>
            </label>
            {capOn && (
              <label className="inline-label">
                <input type="number" min={1} max={168} value={cap} onChange={(e) => setCap(Number(e.target.value))} />
                hours per week
              </label>
            )}
            {msg && <p className={msg.ok ? 'notice' : 'error'}>{msg.text}</p>}
            <div className="card-actions">
              <button>Save settings</button>
            </div>
          </form>
        </>
      )}
    </section>
  );
}
