import { config } from '../config.ts';

/**
 * Pluggable outbound email. Pick a provider with MAIL_PROVIDER:
 *   console  print to stdout (development default; shows reset/invite links)
 *   memory   keep in `outbox` (tests)
 *   resend   Resend HTTP API (RESEND_API_KEY, MAIL_FROM)
 *   webhook  POST {from,to,subject,text} as JSON to MAIL_WEBHOOK_URL (bridge to any provider)
 *   none     drop silently (production default until configured)
 * Adding SMTP or another API is one more entry in `providers`.
 */

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

type Provider = (mail: Mail & { from: string }) => Promise<void>;

/** Sent mail, for tests. */
export const outbox: Mail[] = [];

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

const providers: Record<string, Provider> = {
  console: async (m) => {
    console.log(`\n[mail] to: ${m.to}\n[mail] subject: ${m.subject}\n${m.text.replace(/^/gm, '[mail] | ')}\n`);
  },
  memory: async (m) => {
    outbox.push({ to: m.to, subject: m.subject, text: m.text });
  },
  resend: (m) =>
    post('https://api.resend.com/emails', { from: m.from, to: [m.to], subject: m.subject, text: m.text }, {
      Authorization: `Bearer ${config.resendApiKey}`,
    }),
  webhook: (m) => post(config.mailWebhookUrl, m),
  none: async () => {},
};

const pending = new Set<Promise<unknown>>();

/** Queue a message. Never throws; failures are logged without content. */
export function sendMail(mail: Mail): void {
  const provider = providers[config.mailProvider] ?? providers.none;
  const p = provider({ ...mail, from: config.mailFrom })
    .catch((err) => console.error(`[mail] delivery failed via ${config.mailProvider}: ${err?.message ?? 'error'}`))
    .finally(() => pending.delete(p));
  pending.add(p);
}

/** Track background work (e.g. notification lookups) so tests can wait for it. */
export function background(work: Promise<unknown>): void {
  const p = work
    .catch((err) => console.error(`[notify] failed: ${err?.code ?? err?.message ?? 'error'}`))
    .finally(() => pending.delete(p));
  pending.add(p);
}

/** Wait until all queued mail and notification work has finished. */
export async function flushMail(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}

export const appLink = (path: string) => `${config.appUrl.replace(/\/$/, '')}${path}`;
