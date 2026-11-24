export class ApiError extends Error {
  status: number;
  code: string;
  details?: Record<string, string[]>;
  constructor(status: number, code: string, message: string, details?: Record<string, string[]>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error ?? {};
    throw new ApiError(res.status, e.code ?? 'unknown', e.message ?? res.statusText, e.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

export type Role = 'owner' | 'admin' | 'manager' | 'employee';

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  canReviewReports: boolean;
  managerId: string | null;
  status: 'active' | 'deactivated';
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  timezone: string;
}

export interface Me {
  user: User;
  organization: Organization;
}

export interface ClockStatus {
  state: 'off' | 'working' | 'on_break';
  session: { id: string; clockInAt: string } | null;
  break: { id: string; startedAt: string; kind: 'paid' | 'unpaid' } | null;
}

export interface WorkSession {
  id: string;
  clockInAt: string;
  clockOutAt: string | null;
  breaks: { id: string; startedAt: string; endedAt: string | null; kind: 'paid' | 'unpaid' }[];
  workedSeconds: number;
  unpaidBreakSeconds: number;
  paidBreakSeconds: number;
}

const RANK: Record<Role, number> = { employee: 0, manager: 1, admin: 2, owner: 3 };
export const atLeast = (role: Role, min: Role) => RANK[role] >= RANK[min];
